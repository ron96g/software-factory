# ADR-0072: The plan gate waits visibly for answers, and answers stay bound to their question

- **Status:** Accepted (binding clause amended by ADR-0087)
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Builds on:** ADR-0046 (direct planning decisions), ADR-0050 (one planner run, revocable answers), ADR-0051
  (decision sheet)

## Context
On a `factory-plan` item, the plan review (`spec-review`) opened its human gate while two required decisions were still
unanswered. The page showed "Approve this plan" with an approval form, the stage summary said "Your decision at the
verification-plan-review gate", and the open questions appeared further down. `PlanningService.assertReady` correctly
refused the approval, but the page asked for two contradicting things at once.

One of the two "open" decisions had already been answered. The human answered decision `scope`. The planner then
resolved it and dropped it from the sheet, which is correct. But an earlier run had recorded the same question in its
result, so the planning workspace turned it back into a required, option-less decision (`question-…`). Answers bind
by decision ID or by a signature over question, options and `required`. The recreated decision matched neither, so
the answer showed as "Not in current plan" and the human was asked again.

## Decision
### The gate is presented as a request for answers until the plan is ready
- The plan gate stays the durable human stop (an `Approval`, ADR-0046). Answering decisions happens at this stop, so it
  is not delayed or replaced by a `Clarification`.
- While the planning workspace reports `needs-answers`, the item page shows "Approval waits for your answers" with the
  open questions and a link to them, instead of the approval form. The stage summary says the stage waits for the
  answers. Once the plan is updated with the answers, the approval form appears. The server-side guard
  (`assertReady`) is unchanged and stays authoritative.

### An answer binds to the same question
- A recorded answer binds to a decision when its signature matches (unchanged), or when the decision offers **no
  options** and its question text is the same as the answered question (case and whitespace ignored). An option-less
  decision is an agent's recorded question, and the human already answered exactly that question.
- Decisions with options still need a matching signature. Changed options or a changed question need a fresh answer,
  as before (ADR-0050).
- The same rule decides whether a recorded answer is "current" and whether a decision submission is complete.

## Consequences
- Items like the one above no longer ask an answered question again. The gate shows one clear next step.
- A reworded question (different text) is still a new decision. The earlier answer stays visible under recorded
  answers as "Not in current plan". The planner contract already asks it to keep IDs and wording for unchanged
  semantics.
- AGENTS.md §4 gains X52. No new kind, port or controller.

## Alternatives considered
- **Open the gate only when readiness holds:** the item would need another durable stop for the answers (a
  `Clarification`), which duplicates the decision sheet and the ADR-0046 rule that planning questions are answered on
  the sheet.
- **Fuzzy matching of reworded questions:** could bind an answer to a question the human never answered, which is
  worse than asking once more.
- **Reject plans that re-ask answered decisions (output check):** the re-ask came from an earlier run's recorded
  question, not from the plan, so a check on the plan would not catch it.
