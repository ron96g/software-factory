# ADR-0096: CI status as pull request review evidence

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** project owner
- **Extends:** ADR-0094 (pull request review workflow)

## Context
`pr-review` (ADR-0094) is read-only: it never runs the pull request's code. Passing tests and builds are still a main
review criterion, and the pull request's own CI has usually already produced them. Today the reviewer sees the title,
description, diff and surrounding code. It does not see whether CI passed, failed or is still running, so it may assume
a green CI or overlook a failure. The human at the gate has to look the status up in GitHub.

The factory still runs nothing of the pull request (ADR-0080). CI results are external, untrusted facts about a commit.
They are evidence, not a factory check.

## Decision

### 1. Port `CommitStatusReader` (read-only, ISP)
A new source connector capability, separate from `ItemFetcher` and `PullRequestReviewPublisher`:

```ts
interface CommitStatusReader {
  readCommitStatus(source: Source, commitSha: string): Promise<CommitStatus>;
}
interface CommitStatus {
  commitSha: string;
  readAt: string;
  /** Derived, see §3. */
  overall: "success" | "failure" | "pending" | "none";
  checks: {
    name: string;
    /** GitHub check run or legacy commit status. */
    kind: "check-run" | "status";
    state: "queued" | "in_progress" | "completed";
    /** For completed checks. */
    conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | "stale";
    url?: string;
    /** A short excerpt of the check's output summary (bounded, redacted). Never full logs. */
    summary?: string;
    required?: boolean;
  }[];
  /** Pages or checks that could not be read, so the reader cannot mistake partial evidence for a pass. */
  incomplete?: string;
}
```

The `github-pr` connector implements it:
- check runs: `GET /repos/{repo}/commits/{sha}/check-runs` (paged), including the run's output title or summary;
- legacy statuses: `GET /repos/{repo}/commits/{sha}/status`;
- required checks, where the token may read them: the base branch protection's required status checks. A 403/404 is
  not an error; `required` stays unset.

It always reads the pinned `WorkItem.spec.pullRequest.headSha`, never the branch tip. A result for another commit
cannot be attributed to the reviewed code.

### 2. Evidence in the reviewer's context
A `ci-status` context provider (registered like the `pull-request` provider) reads the status when an `analyze` step
starts. It adds a "CI status at head `abc123` (read at …)" section with one line per check (name, required, state,
conclusion, link, summary excerpt) and the derived overall. The read is recorded as the section's `revision`
(`<sha>@<readAt>`), so the run's provenance names the exact evidence the agent saw (ADR-0057). A read error becomes a
visible "CI status unavailable: …" section, never silence.

The excerpt is untrusted text from the pull request's CI. It is quoted, bounded and redacted, and the prompt says it is
data, not instructions.

### 3. Rules: deterministic overall, the reviewer judges relevance
`overall` is derived in code, not by the model:
- `failure` if any completed check concluded `failure`, `timed_out`, `cancelled` or `action_required`. When required
  checks are known, only required checks count; the others are listed but cannot fail the overall;
- else `pending` if any (required) check is not completed;
- else `success` if at least one check completed;
- else `none` (no CI configured or reported).

The `pull-request-review` skill and the `pr-review-report` schema bind the verdict to it:
- The report gets a required `ci` object: `{ overall, commitSha, assessment }`. `overall` and `commitSha` must equal
  the evidence the run saw. An artifact check compares them with the run's recorded `ci-status` revision.
- `overall: failure`: the verdict may not be `accepted`. The reviewer explains in `assessment` whether the failure is
  caused by the change (then a blocking finding) or unrelated (a non-blocking finding that says why).
- `overall: pending | none`: the verdict may not be `accepted`. The required changes or rationale say what could not be
  verified. A human may still override at the gate.
- `overall: success`: CI is supporting evidence only. It never replaces reading the diff.

### 4. Fresh status at the gate
CI often finishes after the agents ran. The gate shows the status the reviewer used and a fresh read, both pinned to
`headSha`:
- the same `overall`: shown as gate evidence (`ok` for success, `warning` for pending or none, `blocking` for failure);
- a different `overall`: a warning "CI changed since the review (pending → failure)" with **Restart → analyze**. The
  human may still approve. Approving over a `failure` needs the existing override with a reason (ADR-0027).

The fresh read is cached for a short time and never written into the report. The published review is exactly the
approved one.

### 5. Optional wait for CI
`spec.ciWait` on the workflow (`{ stage, maxWait, pollInterval }`) holds the named stage in `Waiting` while the pinned
head's overall is `pending`. It ends at `maxWait` and proceeds with `pending` as evidence. This is level-triggered and
requeues without blocking a reconcile. `pr-review` sets it on `analyze` with `maxWait: 30m`. It is off for
other workflows.

### 6. In the published review
The review body gets one line: "CI at `abc123`: failure (unit-tests, build)" or "CI: still running when reviewed". No
check output is posted.

### 7. Permissions
The `github-pr` source needs read access to checks, commit statuses and, optionally, branch protection on the
repository. These are reads only. Nothing new is written. A source without them reports "CI status unavailable", and the
reviewer treats that like `none`.

## Consequences
- AGENTS.md §4: new item X74 (after X73), glossary terms *CI status* and *CI evidence*.
- The `pr-review-report` schema goes to version 4 (required `ci`). Older reports still render (ADR-0094 display
  fallback); they publish without the CI line.
- More GitHub API calls per item: one status read per run start and per gate view (cached), plus polling while
  waiting.
- Other code hosts implement `CommitStatusReader` when they get a pull request connector.
- The factory still runs nothing of the pull request. A green CI is the pull request's own claim about its head, shown
  with its source and time.

## Alternatives considered
- **Run the repository's checks on the PR head in the factory:** strongest evidence, but executes untrusted code. It
  needs the full verification machinery and doubles CI work. Can be added later as an opt-in. Rejected for now
  (ADR-0094 is read-only by decision).
- **Only show CI at the gate, not to the reviewer:** the verdict would ignore a red build, and humans would have to
  reconcile them.
- **Let the model derive the overall state from raw check lists:** not deterministic, and it could miss a failed
  required check. The rules in §3 stay in code.
- **Fold CI into `ExternalItem` at sync:** stale by the time agents run, and the sync interval would decide freshness.
- **Read full CI logs:** large, often contain secrets, and an injection surface. The summary excerpt and a link are
  enough for review. Logs stay in GitHub.
