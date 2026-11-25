# ADR-0021: Workspace resource: one code state per work item and repository

- **Status:** Accepted
- **Addendum (2026-11-24, store ownership):** the workspaces directory belongs to the **store**, not to the process. Two
  guards follow: an in-memory store gets a throwaway workspaces directory (removed on `stop()`, mirroring the OpenCode
  state directory), and the sweep **refuses to run at all against an empty store** — with no workspaces to compare
  against it cannot tell an orphaned worktree from one another instance still owns. Without them, any short-lived
  instance pointed at the shared `<root>/.workspaces` (a test booting a factory, a second dev instance on its own
  database) deletes every workspace the running factory owns; the app then self-heals each one on its next resync,
  leaving windows where an agent run citing code fails on a missing directory.
- **Addendum (2026-11-23, self-heal):** a `Ready` workspace whose files have vanished (a manual cleanup, a crash, a concurrent sweep) is re-prepared rather than failing every `git` call with `spawn git ENOENT`: the `Workspace` controller asks a `WorkspaceProbe` (`GitWorktreeWorkspaces.exists`), sets the workspace back to `Preparing`, clears `setupCompleted` so setup re-runs, emits a `WorkspaceLost` warning, and re-prepares. Uncommitted changes in the removed worktree are **lost**; the branch is kept (it may back a pull request), so the next attempt rebuilds on it.
- **Addendum (2026-11-24, provisioning):** a **missing** checkout is no longer a failure. When `Repository.spec.local.path` is absent on disk, `GitWorktreeWorkspaces` clones `spec.git.url` into it — a **full** clone, because `git worktree add` needs the history behind the base ref — before adding the worktree. ADR-0008 already allowed a `git clone` behind the same ports, and §Decision anticipated clone-based backends. The token comes from the `SecretResolver` and travels in the environment (`GIT_CONFIG_PARAMETERS`), never in the clone's configuration or its remote URL (SEC-3). An existing usable checkout is reused as-is (no network), an empty directory is cloned into, and anything else — a leftover partial clone included — is **refused** with the path in the message, never deleted. A clone failure names the repository, URL and path, where a missing directory previously surfaced as the misleading `spawn git ENOENT`. `supports()` is unchanged: a repository without `spec.local.path` still gets no workspace. The clone still runs in the factory process (not a sandbox); ADR-0080 moves clone/fetch into the runtime.
- **Date:** 2026-11-11

## Context
In v0.3 the code-researcher searched the operator's checkout, while the developer and verifier worked in a lazily created
worktree. Other agents saw only artifacts. Research and implementation could therefore be based on different code states,
the worktree was invisible to the system (no UI, no cleanup), and it had no setup step (no `node_modules`).

## Decision
- New runtime kind **`Workspace`**, owned by a WorkItem, **one per linked repository**:
  `spec { workItemRef, repositoryRef, baseRef?, branch, setup[] }`,
  `status { phase: Pending|Preparing|Ready|Failed, path, baseCommit, headCommit, preparedBy, message }`.
- The **WorkItem controller** creates its Workspaces when the item starts. It doesn't create agent runs until all of them
  are `Ready`. A `Failed` workspace fails the item, with a visible reason.
- A **Workspace controller** owns the status. It prepares through the `WorkspacePreparer` port and removes the files through
  `WorkspaceCleaner` when the resource is deleted (cascade from the WorkItem).
  - The base commit is **pinned once**.
  - Setup commands come from `Repository.spec.workspace.setup` and run inside the workspace.
- **Every agent works on the same code state:** the execution context carries the item's Ready workspaces. Code search runs
  against them, sandboxes operate in them, and provenance records `repository@commit`.
- **Adapters:**
  - `host`: a Git worktree under `data/workspaces/<item>/<repo>` on branch `factory/<item>`.
  - Container/Kubernetes runtimes will clone into a per-item volume behind the same ports.
- Read-only code tools for analysis agents (triager, architect, reviewer) follow as a separate item (S5b).

## Consequences
One visible, reproducible code state per item, plus cleanup. Items wait briefly until setup completes.
Supersedes the lazy worktree creation in ADR-0020 (the other ADR-0020 safeguards remain).

## Addendum (architecture review of S5a)
- **Cleanup is level-triggered:** the Workspace controller sweeps (`WorkspaceSweeper`) at startup and every 10 minutes, and
  removes workspace files without a resource. The DELETED watch event is only a fast path, and a failed removal is retried.
- `status.setupCompleted`: setup re-runs until it has completed once.
- Deletion is guarded: only paths strictly inside the workspaces directory are removed.
- Known limits: a `Failed` workspace is terminal (recover by deleting the work item); repositories added to an item after it
  started get no workspace; setup commands run unsandboxed, and only when the `host` runtime is selected (operator-authored config).
