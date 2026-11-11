# ADR-0027: Gate evidence and guarded approvals

- **Status:** Accepted (refines ADR-0023 "verifier verdict is advisory")
- **Date:** 2026-11-11

## Context
Human gates showed only Approve/Reject. Failing evidence (the verifier's verdict, failed checks, unresolved AI review
findings) was buried in artifacts and the timeline, so a failed item could be released by accident.

## Decision
1. **Structured verdicts:** `StepSpec.outcomes` declares the allowed outcomes of a step (e.g. the verifier: `pass | partial | fail`).
   They're passed to the agent like decision outcomes and stored in `AgentRun.status.result.outcome`.
2. **Gate evidence:** a pure function derives evidence for a work item from its latest round per step, plus check events:
   - verifier `fail` → **blocking**, `partial` → warning;
   - a check failed with no later pass → **blocking**;
   - AI code review still `changes-requested` (loop exhausted) → warning;
   - triage `needs-info` / unanswered questions → warning.
   The overall status is `ok | warning | blocking`, and it's part of the work-item detail.
3. **Guarded approvals:** approving while evidence is **blocking** requires `override: true` **and** a reason (≥ 10 characters).
   This is enforced in the application service, not just the UI, and recorded as an `ApprovedDespiteFailures` warning event.
   Rejecting is always allowed.
4. **Visibility:** the gate panel shows the evidence list (red/yellow/green) and a red banner when blocking. Artifact headers and
   stage chips show the producing run's verdict.

The verdict still doesn't move the workflow by itself (the verify gate is the automated checks). A human stays in charge, but
can no longer approve failing evidence without noticing.

## Consequences
Accidental releases of failing work need a deliberate, logged override. Teams can tighten this later, e.g. to block overrides
for certain roles in v0.4.

## Addendum: stale evidence
Verdicts and check results recorded **before the latest code change** (the latest successful run that produces
`source-code`) are downgraded from blocking to a warning and labelled "outdated: code changed since". Otherwise a check that
failed before a fix would block the next code-review approval, before the checks could run again.
