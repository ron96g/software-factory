# ADR-0021: Workspace resource: one code state per work item and repository

- **Status:** Accepted
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
