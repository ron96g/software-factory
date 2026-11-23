# ADR-0081: bwrap — narrow the isolation claim and complete the hardening

- **Status:** Accepted. Amends ADR-0079 (its claim, its binding set and its flag set).
- **Date:** 2026-11-22
- **Deciders:** project owner

## Context

ADR-0079 concludes that "agents and checks can no longer read `~/.ssh`, `~/.config`, other repos, or the factory's SQLite
database, while still downloading dependencies and using host toolchains". Three problems with that:

1. **It is true for commands and false for the sandbox's own file capabilities.** `BwrapSandbox.readFile`/`writeFile` are
   implemented with `node:fs` on the host and guarded only by a lexical path check (`bwrap.ts:274-300`), so the tools an
   agent actually uses to read and write files are outside the namespace — `SEC-1`. The ADR's consequences mention
   OpenCode's in-process tools (`SEC-10`) but not the factory's own file helpers, which is what made `docs/security.md`
   necessary.
2. **It binds more than the sandbox needs.** `worktreeGitDirs` resolves the worktree's gitdir **and its `commondir`**
   (`bwrap.ts:41-58`), and both are bound read-only (`:90`). For a linked worktree the common dir is the source
   checkout's `.git`, so a sandboxed command can read every object and ref of the source repository — other items'
   branches when they share a checkout — and the source `.git/config` (`SEC-19`).
3. **It omits cheap hardening.** `buildBwrapArgs` (`bwrap.ts:72-112`) has no `--new-session`
   (terminal input injection, CVE-2017-5226), no `--unshare-ipc`/`--unshare-uts`/`--unshare-cgroup`, no `--cap-drop ALL`
   and no seccomp filter (`SEC-20`). `docs/security.md` §4 marks bwrap commands `✓`; each omission is defence in depth,
   but the claim should be backed by the flags rather than by argument.

This ADR makes the documentation true and the flag set complete. It does **not** claim to fix the file capabilities —
that is P0-1 in `docs/security.md` §7, and in the longer run ADR-0080 moves the file operations into the runtime.

## Decision

### 1. The claim is narrowed, precisely

`BwrapEnvironment` confines **command execution**: `SandboxExec`, and OpenCode's `shell` tool through `ShellConfiner`.

Outside the boundary, by design, until P0-1 and ADR-0080 land: the sandbox's file capabilities
(`readFile`, `writeFile`, `listFiles`, `diff`), OpenCode's own file tools, the git plumbing the factory runs, and
workspace setup. `SandboxHealthInfo.message` says so in those words, and §4 of `docs/security.md` carries the row.

### 2. The binding set is narrowed to what a command needs

Bind read-only: the worktree gitdir, `<common>/objects`, and the worktree's **own** branch ref
(`<common>/refs/heads/<branch>`, read from its symbolic `HEAD`). Do **not** bind `<common>/refs` as a directory, any other
branch, `packed-refs` or `<common>/config`.

The own branch ref is required for `git log`, `git diff` and `git show` to resolve HEAD — it is symbolic
(`ref: refs/heads/<branch>`), so the gitdir alone is not enough; a test asserts they keep working. The residual exposure
is then the source repository's objects and the branch the agent already has, instead of every ref and the checkout's
configuration.

### 3. The flag set is completed

Add `--new-session`, `--unshare-ipc`, `--unshare-uts`, `--unshare-cgroup` and `--cap-drop ALL`. Keep the read-only `/etc`
bind, and document next to it what it is for (DNS resolution, TLS roots, NSS libraries). A seccomp profile is *not*
applied by this ADR; it is recorded as the remaining hardening step for the runtime work of ADR-0080.

### 4. The claim is tested, not asserted

The bwrap test suite must cover: a symlink escaping the workspace, a read of `$HOME`, a read of another worktree's branch
or the source `.git/config`, and the generated argument list (`buildBwrapArgs`) containing the flags above. A runtime
adapter's claim in an ADR is worth what its tests prove (`SEC-14`).

## Consequences

- ADR-0079's consequences are corrected where they overstate, without rewriting them (ADRs are append-only; this ADR is
  the amendment).
- Behaviour changes: refs and the source config are no longer visible inside the sandbox, and four flags are added.
  Nothing else about the adapter changes.
- The honest summary: for **files**, `bwrap` provides no isolation at all today (P0-1); for **commands**, it provides the
  documented namespaces plus the completed flag set. Anyone reading §4 should come away with exactly that.
- AGENTS.md: this ADR supplies the bwrap part of the hardening milestone **P0**; rule 18 is unchanged.
- `docs/security.md`: SEC-1, SEC-10, SEC-19 and SEC-20 stay open until their fixes land; this ADR is the fix for SEC-19
  and SEC-20.

## Alternatives considered

- **Leave ADR-0079 as it is and treat SEC-1 purely as a bug.** Rejected: the wording is what misled a careful reader
  twice, and the file capabilities are a design choice (they are factory-side helpers), not an implementation slip.
- **Wait for ADR-0080 so the file tools become moot.** Rejected: the local runtime stays `bwrap` for as long as there are
  laptops, the flag set costs one line, and the claim correction is needed regardless.
- **Bind nothing from the object store.** Rejected: `git diff`, `git log` and `git show` stop working inside the sandbox,
  and agents need them for ordinary work.
- **Add seccomp now.** Deferred rather than rejected: it needs a profile that keeps the toolchains working (node, go, git,
  package managers) and deserves its own change with its own tests.
