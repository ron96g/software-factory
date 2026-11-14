# ADR-0053: Detect and resolve base-branch conflicts before publishing a pull request

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Maintainers

## Context
Work items run in parallel. Each workspace pins its base commit once (ADR-0021), and the `open-pull-request` outbox
action (ADR-0023) pushed the branch and opened a draft PR without looking at the remote base again. When another item's
change landed on the base branch in the meantime, the factory opened a PR that GitHub could not merge. The workflow did
not notice: the release agent and the human ship gate acted on an unmergeable candidate, and nobody was asked to resolve
the conflict.

## Decision
- **Detect at publication.** The `open-pull-request` handler asks a new `BaseConflictDetector` port whether the current
  candidate (working tree, including an unfinished merge) merges cleanly into the freshly fetched remote base branch.
  Leftover conflict markers in changed files also count. On a conflict it pushes nothing, opens nothing, and delivers
  the result `{ conflict: true, base, baseCommit, files }`. The git adapter (`GitBaseSync`) never modifies the
  workspace while detecting: it writes the candidate as a dangling commit through a temporary index and trial-merges
  it in a throwaway worktree (works with git < 2.38).
- **Publish stages wait for their pull requests.** While this round's PR delivery is pending, the stage's agents and
  gate don't run, so the release agent and the ship approval never act on a conflicting candidate. Failed deliveries
  keep the earlier behaviour: they are visible and don't block.
- **Merge the new base, owned by the Workspace.** On a conflict, the WorkItem controller sets
  `Workspace.spec.integrate { commit, ref, round }`. The round makes each request unique, so answering a clarification
  retries a failed merge of the same commit. The Workspace controller (the owner of `Workspace.status`) runs the new
  `WorkspaceIntegrator` port outside the reconcile: it commits the candidate, merges the base with `--no-commit`, stages
  conflicted files with their markers, and records `status.integration { commit, ref, conflicts, error? }`. It also
  re-pins `status.baseCommit` to the merged base, so diffs, module scope and provenance show only the item's own change.
  The next publication completes the merge commit. If the base moves again before that, the integrator first commits
  the earlier, resolved merge. It refuses while markers are left.
- **Bounded automatic resolution.** `StageSpec.publish.pullRequest.onConflict { next, maxAttempts }` (default 2 attempts)
  routes back to the implementation stage using the `base-conflict` retry counter. The new base and the resolution then
  go through the normal code review, verification and human gates again. A context provider tells agents which files got
  markers and that the base branch's changes must be kept.
- **Humans decide when automation stops.** If there's no `onConflict`, the budget is exhausted, or the merge failed, the
  item blocks on a Clarification (`askedBy.gate: base-conflict`) that names the repository, branch, workspace and files.
  Answering it re-runs the publish stage, which detects again.

## Consequences
- AGENTS.md §4 adds X26. The `factory-loop`, `factory-plan`, `factory-planned` and `factory-verified` workflows declare
  `onConflict: { next: implement, maxAttempts: 2 }`.
- Additive fields only (`Workspace.spec.integrate`, `Workspace.status.integration`, `publish.pullRequest.onConflict`).
  There is no new kind. Rule 7 is kept (detection lives in the outbox handler), and so is rule 8 (the resolution is
  reviewed and verified again before any human approves shipping).
- Detection follows publication, not the sandbox runtime. Whichever runtime prepared the workspace, the default
  publisher pushes from its git checkout, so the git detector and integrator are always wired next to it. Detection is
  a required dependency of the `open-pull-request` handler. A factory that injects its own `BranchPublisher` without a
  `BaseConflictDetector` refuses to start, so no runtime can open a PR without the check. Runtimes without a workspace
  backend can't publish at all. A full checkout per detection costs time on large repositories;
  `git merge-tree --write-tree` can replace it once git ≥ 2.38 is a requirement.
- Only conflicts at publication time are detected. A conflict caused by a base change after the PR is open (for example
  while waiting at the ship gate), and semantic breakage without a textual conflict, are left to the code host's
  mergeability and CI.
- Git credentials are passed through `GIT_CONFIG_PARAMETERS` (supported by older gits too, never on the command line).
- The fetched base is kept under `refs/factory/bases/<workspace>` in the source repository until it's overwritten.

## Alternatives considered
- **A separate "resolve conflicts" workflow or WorkItem:** this would split one change across two items, with its own
  gates and evidence, and lose the original review and verification binding.
- **Always rebase or merge the newest base before verification:** this catches semantic drift, but it invalidates
  evidence on every unrelated merge and churns long-running items. It can come later as an opt-in.
- **Detect in the WorkItem reconcile:** network and checkout I/O would block the control loop, and the detection would
  be separated from the push it guards.
- **Let the publisher merge the base automatically:** this would push code that nobody reviewed and that may not build.
