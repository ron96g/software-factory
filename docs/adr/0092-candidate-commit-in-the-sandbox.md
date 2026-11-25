# ADR-0092: The publication commit is made in the sandbox

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** project owner
- **Amends:** ADR-0023 (pull request publication), ADR-0080 §13 (export contract), ADR-0091 (lease push)
- **Related:** SEC-2/SEC-3 (`docs/security.md`), ADR-0079/ADR-0081 (`bwrap`), ADR-0088 (sandbox toolchain and `HOME`)

## Context
`GitBranchPublisher` committed the candidate **in the factory process**: `git add -A` and `git commit` ran with the
agent-writable workspace as working directory. Hooks, fsmonitor, pager and editor were disabled, and the token reached
only the push (S1), but repository-local `filter.*`/`diff.*` drivers still ran as the factory user. The rule this
repository holds itself to — *everything a repository controls runs in the sandbox* (AGENTS.md rule 18, ADR-0080) —
was not met by the step that produces what is published.

Two further forces:

- Repositories enforce their standards in **git hooks**. `controlplane` runs the pre-commit framework with
  `conventional-pre-commit` (commit-msg), `reuse-lint-file` and `gitleaks`. The factory committed with `--no-verify`
  and a fixed message (`<title>\n\nWork item: <name>`), so its pull requests violated the repository's own rules.
- Committing **inside** `bwrap` was impossible: workspaces are worktrees of one shared clone, and `.git`, the object
  store and the branch ref are mounted read-only so one item cannot write another item's refs (SEC-19).

Pushing from the sandbox was rejected (see Alternatives): it would put a credential where candidate code runs.

## Decision
1. **A commit job in the sandbox.** Publication runs a short job in the execution environment
   (`SandboxCommitter.commitCandidate`; `bwrap` implements it). The job sees the workspace through a **throwaway
   overlay** (`--tmp-overlay`: writes go to an invisible tmpfs, so hooks may write caches but the candidate never changes)
   and a factory-created scratch directory read-write. It creates a private git directory there whose object store borrows
   the workspace's objects through `alternates` (read-only), reads the workspace `HEAD` (and `MERGE_HEAD` of an
   ADR-0053 base merge), stages the working tree into a private index, commits, and writes a **self-contained bundle**
   of `refs/heads/<branch>`. Nothing is written to the shared repository. The job holds no token.
2. **The factory only ingests and pushes.** `GitBranchPublisher` ingests the bundle into a factory-owned bare mirror
   (ADR-0080 §13: limits, `fsck --strict`, no checkout, submodules refused) and pushes the ingested commit with the
   ADR-0091 lease. The factory no longer runs any git command with an agent-writable working directory to publish.
3. **Hooks are opt-in per repository** — `Repository.spec.git.commit.hooks: <type>`, a reviewed definition
   (never an environment variable). Types are registered (`CommitHookSetup`), not switched on: `pre-commit` installs
   the hooks of the candidate's `.pre-commit-config.yaml` (honouring `default_install_hook_types`) into a private git
   directory and commits **with** verification. Without the field no hook runs.
4. **Two runs: the published commit never comes from the hook run.** The **commit run** executes only the factory's
   script, never runs a hook, has no network (`--unshare-net`) and writes only its own directory; its bundle is what the
   factory ingests and pushes. With hooks, a separate **hook run** then commits the same tree and message (given as
   `EXPECTED_TREE`) with verification, writes no bundle, and can only **pass or fail** publication. It cannot reach the
   commit run's directory, keeps the item's sandbox `HOME` and outbound network (hook environments install from their
   repositories, ADR-0088), and sees the workspace through its own throwaway overlay.
5. **A hook may check, never change.** The hook run fails when the committed or re-staged tree differs from the
   expected one; its writes vanish with the overlay. This verdict comes from candidate-controlled code, so a passing
   hook is a **standards check, not a security control** — a malicious candidate can make its own hooks pass, but it
   cannot change what is pushed, because that comes from the commit run. (Formatting belongs in a check or the
   developer's own run.) Tools a hook needs are declared on the repository's sandbox profile (ADR-0088), e.g.
   `codespell` for controlplane's `audit-gate`. A rejection carries the tail of the job's output in its message, so the
   outbox and the item show why (e.g. a non-conventional message).
6. **Commit message conventions are declared.** `Repository.spec.git.commit.convention: <type>` selects a registered
   formatter (`conventional`: `<type>: <title>` with the type derived from the item's classification — `bug` → `fix`,
   otherwise `feat`); without it the message stays `<title>\n\nWork item: <name>`. The work-item trailer is kept.
7. **Unhardened workspace git is a bug.** The remaining host-side git calls with a workspace `cwd`
   (`module-scope.ts`, `local-reader.ts`) use `GIT_HARDENING` and a scrubbed environment.

## Consequences
- SEC-2 narrows: publishing no longer executes repository-local configuration in the factory process. Still open
  (stage 2): the base sync (ADR-0053) fetches **with the token** in the workspace and merges there, and the snapshot,
  checkpoint and module-scope plumbing still run hardened host git in the workspace. Those move to a factory-owned
  mirror (fetch) and the sandbox (merge) next.
- The pushed commit is built from the workspace at delivery by the factory's own script; binding its tree to the approved
  candidate fingerprint (verification) is a follow-up — the commit run reports the tree so it can be checked.
- A deterministic hook failure is not routed back to the developer yet: the outbox delivery fails visibly and retries
  with backoff. Repositories that want feedback before review should also run their hooks as a preparation check
  (`pre-commit run --from-ref {{base}} --to-ref HEAD`).
- Publication now needs an execution environment that implements `SandboxCommitter`; without one (`none`), the
  delivery fails visibly instead of committing on the host. Tests use a host committer helper.
- The job writes a self-contained bundle of the branch's history, as the publisher did before (same ingest limits).
- The job commits anew on every delivery, so an unchanged candidate would get a new timestamp; the publisher keeps the
  published head when its tree and parents equal the candidate's (no force-push, no CI re-run).
- The workspace branch no longer advances at publication, and an ADR-0053 merge stays pending in the workspace
  (`MERGE_HEAD`) until the next integration; every publication re-creates the merge commit from it.
- Validated against controlplane: its full pre-commit set (reuse, gitleaks, audit-gate, conventional-pre-commit) runs
  in `bwrap`; a non-conventional message and a content-changing hook are rejected; the workspace stays unchanged.
- Requires bwrap ≥ 0.8 (`--tmp-overlay`); `bwrap` health reports when publication commits are unavailable.
- The hook run uses full outbound network regardless of the profile's allowlist (same as every `bwrap` command, SEC-6)
  and the item's persistent sandbox `HOME`, so a hook can leave cache state for later commands of the same item — the
  same exposure as any command the candidate runs there (SEC-22).
- Each publication with hooks runs the hook set once more (controlplane: about a minute).
- AGENTS.md §4: new item X71. `docs/security.md`: SEC-2 status and P0-2 updated.

## Alternatives considered
- **Push from the sandbox.** Rejected: the token would be readable by everything the candidate runs (hooks, tests,
  agent), and GitHub tokens cannot be limited to one branch, so it could push `main` or `.github/workflows`. The factory
  could also no longer verify that it publishes exactly the reviewed commit.
- **Run hooks on the host behind an opt-in.** Rejected: executes candidate-controlled code as the factory user (rule 18).
- **Make the shared object store writable in the sandbox.** Rejected: breaks SEC-19 — one item could write another
  item's refs and objects.
- **Accept hook modifications (formatters).** Rejected: the pushed tree would differ from what humans reviewed.
- **Run hooks in the same job that produces the bundle.** Rejected in review: a hook could rewrite the bundle and the
  job's own checks, and the factory would push content no human reviewed.
