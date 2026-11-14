# ADR-0048: AI plan review advises; the human decides

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Amends:** ADR-0046 (only its rule that unresolved AI review findings block plan approval)

## Context
ADR-0046 kept the independent AI plan review "independently enforced": a human could not approve a plan while the
reviewer still returned `changes-requested`. The review loop is bounded (two rounds), so a persistent reviewer left
the human with only one action, a full regeneration of several minutes that could end the same way. In practice the
AI reviewer had a veto over the human, which contradicts "AI proposes, humans approve" and left items stuck.

## Decision
- Unresolved AI plan review findings are advisory evidence. The plan workspace shows them prominently, and approving
  over them requires an explicit human reason of at least 10 characters, stored on the Approval (decidedBy, comment).
  Without a reason the server rejects the approval. Requesting a revision remains available.
- Everything else stays enforced: answered required decisions, current and real planning evidence, exact-revision
  binding, verification policy, the Unit manifest (ADR-0047) and blocking gate evidence overrides (ADR-0027).
- A new narrow port, `PlanningReviewOutcome`, exposes whether the review still requests changes; the verification
  approval guard consumes it. Construction-time readiness no longer re-checks the AI verdict, because the human's
  decision with reason is the binding record.

## Consequences
- Items no longer dead-end on a disagreeing AI reviewer. The reviewer's value is preserved as visible, auditable
  input. AGENTS.md X28 records the change.
- Humans can approve a weak plan with a reason; this is the intended authority, and the reason stays auditable.

## Alternatives considered
- More AI review rounds: slower, and still a veto when the reviewer never converges.
- Hide the findings: loses useful input and accountability.
