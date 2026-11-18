# ADR-0058: Bounded agent runs end with a wrap-up step

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** project owner
- **Amends:** ADR-0057 §4 ("a run that never calls `finish` within its step budget still fails as today")

## Context
A developer run spent its 30-step budget fixing timing-sensitive tests. It had just succeeded when the loop stopped
with "tool loop did not finish within 30 steps". The run failed, the WorkItem failed, and the agent's summary of its
work was lost, although its changes remained in the workspace. The agent never knew its budget: nothing in the
prompt or the conversation said how many steps it had or that it was about to run out.

## Decision
- The tool guide (ADR-0057 §2) states the run's step budget.
- When three or fewer steps are left, the harness appends a recorded notice to what the model reads next, telling it
  to wrap up and call `finish`.
- The last step offers only `finish`, with a recorded notice asking for a summary of what was completed and what is
  unfinished or unverified. Other tool calls in that step are not executed.
- A result reported in that step is marked `toolUse.wrapUp` in provenance and goes through the normal post-run
  checks, reviews and gates. It is not treated as complete or approved because it was produced under budget pressure.
- A run that does not call `finish` even in its last step fails as before. Budgets themselves are unchanged.

## Consequences
- Running out of budget produces a reviewable result and an honest summary instead of a failed item.
- Partial work can reach review sooner; review and verification gates still decide whether it is acceptable.
- Notices are appended to the last tool result or user message, preserving tool-call/result pairing for providers.
- AGENTS.md adds X38.

## Alternatives considered
- **Raise the budget:** postpones the same failure and costs more on runs that go astray.
- **Return the last tool result as the result:** produces no summary and no outcome for the gate.
- **Per-agent budgets in agent definitions:** possible later; it does not remove the need for a graceful end.


> Amended by ADR-0067: an assigned run that exhausts its step budget without `finish` now retries the attempt (one attempt charged) after a finish-only correction step.
