# ADR-0024: Bounded review→fix loops and visible control-loop errors

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
The AI code review found real defects, but its findings only reached humans: the developer never fixed them before the human
gate. Separately, a reconcile that kept failing (e.g. an invalid outbox message) was visible only in the server log, and the
item looked "Running" forever.

## Decision
### Review → fix loop (Q1)
- `StageSpec.loop: { when: { outcome }, goto, maxAttempts }`. After the stage's steps, if `status.lastOutcome` matches, the
  WorkItem controller goes back to `goto`, before the stage's gate. The rounds are counted in `status.retries[stage]`, the same budget
  as check retries (ADR-0023). When the budget is used up, a `LoopExhausted` warning is recorded and the normal gate decides.
- The last step of a looping stage gets the outcomes `approve | <when.outcome>`. The `code-review` skill requests changes only for
  **blocking** findings, and makes them actionable (`repo:path:line`, how to verify).
- New artifact type `code-review-report`, separate from the spec `review-report`. It's an input of `write-code`, and the developer
  fixes blocking findings first.
- `construction-bolt` is split into `design` (domain model) and `implement` (`write-code`), so loops and check retries re-run
  only the implementation.

### Visible control-loop errors (Q2)
- Controllers declare their `primaryKind`. The controller manager reports failures to a `ReconcileErrorReporter`.
- The default reporter emits a `ReconcileFailing` Warning event on the affected object at the 3rd consecutive failure and then
  every 10th (no spam), plus `ReconcileRecovered` when it succeeds again. Messages are redacted.
- `ControllerHealth.failing()` feeds system health. The UI header shows a red "N failing" badge with details.

## Consequences
Humans review code whose blocking AI findings have already been addressed, and stuck items explain themselves in their timeline.
The loop costs extra LLM rounds (bounded by `maxAttempts`).

## Addendum (architecture review)
- `LoopExhausted` is recorded **exactly once** per stage round, via the status marker `loopExhausted: <stage>@r<round>`.
- The reporter drops entries for objects that no longer exist, so its memory stays bounded.
