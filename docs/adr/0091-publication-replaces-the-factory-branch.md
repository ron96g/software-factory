# ADR-0091: Publication replaces the factory branch with a lease

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** project owner
- **Amends:** ADR-0023 (pull request publication), ADR-0053 (base conflicts)
- **Related:** ADR-0080 §13 (the push runs from a factory-owned bare mirror), SEC-2/SEC-3 (token and untrusted config)

## Context
An item (`file-download-proxy-in-controlplane-api-for-files-stored-in`) reached `ship` and published a draft PR. A human
then used GitHub's "Update branch" twice, merging `main` into the `factory/file-download-proxy-…` branch. The remote
head moved (`c589bc0a → merge → merge`). The factory's workspace branch still forked from the original base
(`c589bc0a → revert`), so `git push <candidate>:refs/heads/factory/…` was rejected as a non-fast-forward:

```
! [rejected] refs/factory/export/candidate -> factory/file-download-proxy-… (fetch first)
```

The outbox retried with backoff and could never succeed. `GitBranchPublisher` (ADR-0023) never read the remote head, so
it could not tell "the branch does not exist yet" from "someone else pushed to it". Two model facts were missing:

- the factory **owns** its `factory/*` branch — it is derived from the workspace, not a shared integration branch;
- the base is reconciled by the factory itself (ADR-0053 merges the moved base into the workspace when it conflicts),
  so foreign commits merged into the head branch are not the factory's input.

## Decision
`GitBranchPublisher.publish` reads the remote head (`git ls-remote --heads <url> refs/heads/<branch>`) just before the
push and pushes with **`--force-with-lease=refs/heads/<branch>:<head>`**:

- the factory replaces its own branch with the workspace candidate, so a moved remote head never blocks publication;
- the push is a compare-and-swap: it is forced against the head read a moment earlier, and fails only if the branch
  moved again in between. The outbox delivery then retries, and the next attempt re-reads the head. A first publication
  (branch absent) leases against "must not exist", which is the same push it was before.

The factory never integrates foreign commits into the candidate and never rewrites the workspace from the remote: the
workspace stays the single source of truth for the branch, and the base is still reconciled through ADR-0053. The push
continues to run in the factory-owned bare mirror, with the token only on that process (ADR-0080 §13, SEC-2/SEC-3).

## Consequences
- A human action on the pull request ("Update branch", a commit pushed to the head) no longer wedges an item in a
  retry loop; the next delivery replaces the branch with the reviewed candidate.
- The factory branch is explicitly derived: its history is the workspace's, not a merge of external commits. A human who
  wants main's changes in the PR should let the factory reconcile the base (ADR-0053), not merge into `factory/*`.
- A concurrent push still loses safely: the lease makes the factory's push fail and retry rather than clobber a push it
  did not see. There is a small window between the read and the push; the lease closes the correctness gap, not the
  window itself.
- `base-sync.test.ts` covers the moved-head case (a divergent push to `factory/item`, then a successful publish that
  replaces it). AGENTS.md gains X70.

## Alternatives considered
- **Fetch the remote head and merge it into the workspace.** Keeps a human's merges, but changes the candidate, so it
  re-runs review and verification, and it puts external commits into the candidate the factory believes it reviewed.
  Rejected: the factory's model is a derived branch, not a shared one.
- **Push a new branch (e.g. `factory/<item>-2`).** Avoids the rejection but abandons the open PR and its discussion.
- **Detect the divergence and block for a human.** Preserves nothing useful and leaves the item stuck; the human's
  intent (keep the PR current) is already served by the factory's base reconciliation.
- **Leave it as an operator task (reset the branch by hand).** That is what this ADR removes.
