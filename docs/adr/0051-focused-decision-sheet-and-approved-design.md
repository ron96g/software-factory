# ADR-0051: Focused decision sheet and a human-approved design

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Amends:** ADR-0045 (implementation-plan content) and ADR-0050 (`factory-plan`) for one-planner workflows;
  `factory-planned` and `factory-loop` are unchanged.

## Context
The `implementation-plan` artifact has six Markdown sections and a decision sheet. In `factory-plan` the planner writes
it in the same run as `spec`, `units-of-work` and `validation-plan`. Outcome and scope restate the specification,
delivery restates the Units, and acceptance restates the validation plan. These short restatements refer to IDs defined
elsewhere, so humans found the plan hard to read. The approach section is a technical design written before the code
is fully researched, although AI-DLC places domain model and logical design in Construction. In `factory-plan`, the
`design` stage had no human gate, so the only human view of the "how" was this early approach.

Merging design into the plan stage was considered and rejected. It makes review heavier, forces every design tweak
through a full re-approval, makes the planner run larger, fixes the design before construction learns anything, and
works against per-Unit design (v1.0).

## Decision
- A planning policy can declare `planFormat: decision-sheet`. `factory-plan` does this. The default (`full`) keeps
  the six-section format for legacy workflows.
- A decision-sheet `implementation-plan` contains only `risks` (risks, assumptions and open points in plain language)
  and `decisions`. It must not contain outcome, scope, approach, delivery or acceptance. The output check rejects
  both formats when they do not match the workflow, so the planner corrects them immediately (ADR-0049).
  Existing plans in the wrong format are shown, but a fresh revision is required before plan approval.
- The planning workspace shows the current specification, Units of Work and validation plan from the same planner
  run as the source of "what" and "how it is proven", followed by the decision sheet. Human section edits apply
  only to the sections of the workflow's format. Edits, feedback and answers keep their existing semantics.
- The `factory-plan` `design` stage keeps its own architect step. The architect also consumes the specification and
  research notes, and produces the domain model plus the logical design (approach, alternatives with code citations,
  per-Unit notes) in the existing `domain-model` artifact, using a new `logical-design` skill.
- A `human-approval` gate (tech lead) follows `design`. Rejection reruns `design`, with the reason as agent input
  (X7). The approval is ordinary gate evidence and is not bound into the plan approval fingerprint. The generic
  approval panel shows the artifacts produced in the gated stage.
- Construction agents follow an approved design and report necessary deviations with reasons in their results.
  Changed scope still returns to planning.
- No new kind, controller or port is added. Format enforcement moves from a static artifact check into the planning
  service, which compiles the item's workflow. The composition root registers it.

## Consequences
- Plan reviewers read the specification, Units and validation plan directly, plus a short decision sheet without
  duplicated text. The technical design is reviewed separately, after preflight and before code exists.
- `factory-plan` items pause twice before code: plan approval (product owner and tech lead) and design approval
  (tech lead). Items already in `factory-plan` with a six-section plan need a revision before plan approval.
- The design is approved once per item, not per Unit. Per-Unit design remains part of the v1.0 Bolt fan-out.
- AGENTS.md adds X31. The glossary and architecture document the decision sheet and the design gate.
- Exit tests: decision-sheet plans pass only in decision-sheet workflows and full plans only in full workflows; the
  workspace exposes the planner's source artifacts; requests accept either section shape; `factory-plan` declares
  the design gate.

## Alternatives considered
- Keep the six sections and improve wording only: the duplication and the early design remain.
- Move all design into the plan stage: rejected for the reasons in Context.
- Drop the implementation plan entirely: decisions need a structured, stable home that the approval fingerprint binds.
