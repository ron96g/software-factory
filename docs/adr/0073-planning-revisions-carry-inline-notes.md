# ADR-0073: Planning revisions carry the draft inline notes

- **Status:** Accepted
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Amends:** ADR-0071 (inline artifact feedback)
- **Builds on:** ADR-0050 (one planner run, revocable answers)

## Context
On a planned item a human can give the planner three kinds of input: decision answers and requested changes (planning
workspace, `PlanningCommands.revise`), and inline feedback notes (ADR-0071). Each submission restarted planning by
itself. Answering decisions and then submitting notes cost two planner runs and two reviews, and the first run did
not see the notes.

## Decision
- A planning revision (`revise`, `decisions` or `reopen`) also submits the item's **draft** inline notes on the stages
  it re-runs: the revision stage and every later stage. They are marked submitted with the batch ID
  `plan-<requestId>`, the same ID as the restart. Delivery stays as in ADR-0071: the next run of the producing step
  receives them once.
- Notes on earlier stages (e.g. the triager's research notes) stay drafts. The planning restart doesn't re-run those
  stages, so the notes could not reach their agent.
- Closing a proposal (`reject`, `defer`) takes no notes, and neither does a workflow migration.
- The new port `DraftFeedbackBatch` (`include`, `release`) keeps `PlanningService` unaware of the `InlineFeedback`
  store. Notes are marked before the restart is written; if the write fails they are released back to drafts.
- The planning workspace shows how many notes go along. The feedback bar points to this option. Submitting notes on
  their own (ADR-0071) is unchanged.

## Consequences
- Answers, requested changes and notes reach the planner in one run.
- `PlanningWorkspace` gains `revisionStage` so the UI can count the travelling notes.
- A process crash between marking the notes and writing the restart leaves them submitted without a re-run (single
  process, ADR-0010). They then show as "submitted", not addressed. Worker leases (v1.0) can close this window.
- AGENTS.md §4 gains X53.

## Alternatives considered
- **Submit notes and the revision as two requests from the UI:** two restarts, which is the problem.
- **Move inline notes into `spec.planning.feedback` text:** loses the quote/version anchoring and the "addressed"
  state of ADR-0071.
