# ADR-0045: Plan-first workspace and bounded human decisions

- **Status:** Superseded by ADR-0046
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Extends:** ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0027, ADR-0032, ADR-0042

## Context
Planning is the primary human interaction in AI-DLC, but separate artifacts and repeated per-agent clarification
rounds make the proposal hard to review. HumanLayer's research/design/implementation workflow and testable
implementation outlines are useful inspiration; its sequential interview is not appropriate for this factory.
The owner selected a plan-first workspace with consolidated decisions and explicit approval of a revision.

## Decision
- Introduce the opt-in `factory-planned` workflow. Existing workflows, items, reviews and publication permissions
  remain unchanged. New items select this workflow explicitly; there is no automatic migration or restart.
- Reuse Artifact, AgentRun, Approval and WorkItem resources; do not introduce a Plan kind or separate persistence.
  An `implementation-plan` JSON artifact presents outcome, scope, approach, ordered delivery, acceptance and risks
  as readable Markdown sections, plus stable structured decision IDs/options/recommendations/rationale/required flags.
  This is a human-readable implementation plan, not a replacement for the policy-controlled `validation-plan`.
- Planning agents research discoverable facts and produce provisional documents without stopping for confirmation.
  All planning questions are retained in run results and collected at one review surface. The synthesis and independent
  review must account for upstream questions. Missing answers are not permission to invent high-impact requirements.
- Required decisions have no implicit answer. Optional reversible choices expose a recommendation. Human answers
  bind the decision's question, options and required flag; changed semantics invalidate an answer. One submitted
  decision batch is shared across agents and survives restarts/revisions. Further unanswered decisions remain visible
  blockers, not another automatic interview. A human must explicitly reopen discovery to submit another batch.
  Aim for three to five decisions; never truncate or conceal essential blockers to meet a question limit.
- The workspace saves direct section edits, context, bundled feedback and answers as human intent in
  `WorkItem.spec.planning`, using optimistic concurrency and request identity. Original agent artifacts remain history.
  Saving starts an asynchronous revision from requirements, then decomposition, validation, synthesis and independent
  review. The previous proposal and section-by-section before/after comparison remain inspectable. Saving is not approval.
  Revisions require no active agents/checks or publication effects; running work must reach a safe human stop first.
- The verification plan approval additionally binds human intent/context, Units, implementation plan, decision answers
  and independent review. Real current producers/reviewers must have consumed the exact upstream revisions and planning
  intent. Required unanswered decisions or unresolved upstream questions block approval and construction even through
  generic approval/restart APIs. Missing/stale/simulated/replay evidence cannot establish readiness.
- The pending Approval is the durable decision sheet, including when input is still required. Decision submission
  regenerates a proposal; the human reviews and explicitly approves the generated result. AI review findings and
  mandatory verification policy remain independently enforced. Ordinary rejection requests revision from requirements;
  explicit reject/defer commands close the proposal with an audited disposition.
- During construction the reviewed plan remains visible alongside actual workflow progress and acceptance/check evidence.
  No invented per-Unit completion is shown: real per-Unit fan-out is still deferred to v1.0. Scope amendments re-enter
  planning and invalidate dependent output/reviews. Publication already started cannot be undone by amending a plan.
  Existing code review, verification, waivers, sandboxing, outbox and publication holds are unchanged.
- New segregated planning query/command, review-binding, question and lifecycle policy ports are wired only in the
  composition root. The existing verified review gate is decorated through its ports, not a core workflow-name switch.
  Planning context is recorded with a revision in agent provenance; no new unrecorded LLM interaction is introduced.

## Consequences
- AGENTS.md adds X26 and the glossary/architecture document the planning workspace, decision batch and plan revision.
- Context edits retain ADR-0032's legacy behavior. On planned items, changed context makes the proposal stale and
  requires a fresh revision before approval/construction; saving context is never authorization.
- Validation must cover shared decision budgets, changed decision semantics, concurrent edits, retries/restarts,
  safe revision boundaries, real/current review provenance, stale approval rejection and unchanged legacy behavior.
- Future attachment ingestion, live collaborative editing and real per-Unit execution are out of scope.

## Alternatives considered
- A chatbot interview: rejected because human progress depends on repeated model latency.
- UI-only artifact aggregation: useful but cannot enforce decision budgets or prevent stale approvals.
- A new Plan resource: unnecessary while existing immutable agent artifacts and human-owned WorkItem intent suffice.
- Automatically approve after answers or edits: rejected because the human has not reviewed the regenerated result.

## References
- https://github.com/humanlayer/skills/blob/main/plugins/rpi/skills/rpi/references/workflow.md
- https://github.com/humanlayer/skills/blob/main/plugins/rpi/skills/rpi/references/create-structure-outline/references/structure_outline_template.md
