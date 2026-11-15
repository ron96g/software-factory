# ADR-0055: Schema-backed planning reviews

- **Status:** Accepted
- **Amended by:** ADR-0057 (validation at `finish`, `planning-review` schema version 2 with code evidence)
- **Date:** 2026-11-15
- **Deciders:** project owner
- **Amends:** ADR-0048 (typed advisory findings), ADR-0049 (invalid output exhaustion), ADR-0050 (planning review output)

## Context
An independent reviewer described essential human questions only in Markdown while returning `questions: []`.
The decision sheet consequently reported no unanswered questions and readiness despite the review's open decisions.
Prompts alone cannot enforce the relationship between a report, decisions, evidence and workflow routing.

## Decision
- ArtifactType may declare `spec.schema: { version, jsonSchema }`, using strict JSON Schema draft 2020-12.
  Schemas are compiled locally without remote reference loading. Invalid definitions fail startup and CI validation.
  Schema-backed output is validated before its producing step advances, followed by registered domain checks.
  Validation errors identify JSON paths, violated keywords and relevant parameters. Recorded output feedback returns
  them to the same producing agent, which retries without rerunning prior steps or discarding unrelated valid work.
  Exhausting malformed-output retries fails visibly at that step; invalid output never advances to a gate.
- `factory-plan` produces a new JSON `planning-review` artifact instead of Markdown `review-report`. Other workflows
  and historical Markdown artifacts remain readable and unchanged. Existing factory-plan proposals need a new
  revision before approval; this change does not restart, answer or approve live items.
- Reviews contain a version, summary, typed findings and proposed human decisions. Findings are research gaps,
  plan defects, human decisions or advisory concerns, each with a stable ID and exact input artifact evidence.
  Human findings reference required, answerable decisions in the proposal or review. Every review-proposed decision
  must be referenced; conflicting IDs, missing/stale evidence and unstructured result questions reject the output.
  Re-asking an already answered decision with unchanged semantics is also rejected for the reviewer to correct.
  The declared AgentRun outcome must agree with the finding-derived outcome. Markdown reports are not parsed.
- Schema contracts are supplied in recorded agent context. Plan approval additionally binds the current review schema
  digest and verifies the review producer saw that contract. Schema changes cannot silently reinterpret approval.
- Planning merges review-proposed decisions into the existing answer surface. Existing semantic answer signatures,
  exact-revision approval, human-controlled withdrawal and explicit verification waivers remain enforced.
  No fuzzy matching, automatic answer supersession or assumption that changed options preserve an answer is added.
- The UI renders typed review findings directly and distinguishes agents working, needs agent repair, needs answers,
  ready for review, and ready with disputed findings. Required answers and invalid evidence cannot be overridden.
  Valid AI research/plan concerns remain advisory after the bounded repair loop; accepting them needs a human reason
  under ADR-0048. Neither JSON Schema nor a citation proves a claim true.
- This increment is the first slice: schema validation, typed planning review, decision-reference enforcement,
  contract binding and truthful readiness. Durable cross-revision finding-resolution accounting and broader
  decision lineage are follow-ups, not inferred from wording or implemented as hidden state.

## Consequences
AGENTS.md adds X35. ArtifactType gains an optional schema, but no resource kind or database migration is introduced.
The existing ArtifactCheck registry, context providers, output retries, planning workspace and approval guards
remain the integration points. A local JSON Schema validator is an adapter behind a narrow port.
Definitions and their schema-check registrations load at startup, as in the existing definition store; edit Git
definitions and restart to apply a schema change. There is no runtime API for adding or editing ArtifactTypes.
Acceptance tests cover malformed output, decision linkage, stale contracts, advisory override and historical output.

## Alternatives considered
- More prompt instructions or Markdown question extraction: cannot provide a reliable machine contract.
- Convert all artifacts now: unnecessarily broad; other workflows retain their contracts.
- Let AI findings veto humans or approve defaults automatically: violates the existing human authority model.
- Unlimited repairs: potentially unbounded cost without guaranteed convergence.
