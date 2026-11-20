# ADR-0050: One planner run, one review, and revocable human answers

- **Status:** Accepted (implementation-plan format and design gate amended by ADR-0051; `factory-planned` removed by ADR-0074)
- **Amended by:** ADR-0055 (schema-backed planning-review output in factory-plan)
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Would supersede:** the planning chain of ADR-0045/0046 for new planned items (`factory-planned` stays for
  items already in it); amends ADR-0042's rule that the validation plan must consume the specification as an input.
- **Builds on:** ADR-0047 (Unit manifest), ADR-0048 (advisory AI review), ADR-0049 (output checks)

## Context
Every planning change reruns five sequential agents: product-owner spec, architect units, architect validation
plan, architect implementation plan, AI review. That costs about four minutes per revision, plus up to two automatic
review rounds, and each hand-off loses context. The same architect wrote three of the four artifacts in separate runs
and repeatedly reported "files not read", while the reviewer flagged contradictions between artifacts written
minutes apart. Answering one decision also reruns the whole chain.

Human answers are recorded as permanent intent. When reality changes (here: an operator configured the checks that
decision D9 said this item would add), the stale answer keeps steering agents. The only remedy is free-text feedback
and another full regeneration.

## Decision
### One planner run produces the whole plan
- A new opt-in workflow, `factory-plan`, replaces the four planning stages with one `plan` stage. In it, a `planner`
  agent (reasoning tier, read-only code tools: `search_code`, `read_file`, `list_files`) produces `spec`,
  `units-of-work`, `validation-plan` (including the ADR-0047 Unit manifest) and `implementation-plan` in a single
  run. It reuses the existing skills (requirements elicitation, unit decomposition, validation planning,
  implementation planning). Classify and triage with code research stay as they are.
- The workflow declares `planning.plannerStage`, and its verification `planningStage` is the same stage. The existing
  separate `revisionStage`/`synthesisStage` policy remains valid for `factory-planned`.
- Artifacts from one run are consistent by construction, so the provenance rules change accordingly:
  - The planning evidence binding requires all four artifacts to come from the **same** real, current, non-replay,
    non-superseded planner run that consumed the current planning intent, instead of a chain of runs that each
    consumed the previous artifacts.
  - The verification contract accepts a validation plan produced in the same run as the specification. Specification
    and plan revisions remain part of the approval fingerprint.
- ADR-0049 output checks apply to each artifact. A rejection reruns only the planner step, with the reason in its
  context.

### One independent review, then the human
- A `spec-review` stage keeps one `ai-plan-review` step by a different agent that consumes all four exact artifact
  revisions. At most one automatic review-to-planner round; the review report is planner input on that round.
  After that the human decides (ADR-0048: findings are advisory and overruling needs a reason).
- The existing `verification-plan-review` human gate and plan-approval binding stay unchanged.

### Revisions rerun only what they need
- With planning in one stage, every revision (edits, feedback, answers) restarts at `plan`: one planner run plus one
  review instead of five agents. A partial-rerun mechanism across stages becomes unnecessary and is not built.

### Revocable human answers
- The planning workspace lists recorded answers, including answers to decisions that no longer appear in the
  current plan, with their question and date.
- A human can change an answer's text or **withdraw** it. A new `withdraw: string[]` field on
  `PlanningRevisionInput` (decision IDs) removes the answers from `WorkItem.spec.planning.answers`. A bounded record of
  the last 100 withdrawn answers (`decisionId`, `question`, `answer`, `withdrawnBy`, `at`) is kept in a new
  `spec.planning.withdrawn` field. Answer records carry `answeredAt` so the workspace can show their age.
  Like any revision, it restarts planning; nothing is approved.
- Agent context lists withdrawn answers explicitly as no longer binding, so the planner can drop the scope they
  introduced instead of silently re-deriving it from older artifacts.

### Rollout
- `factory-plan` is the default for new manual items and available for explicit selection elsewhere. `factory-planned`
  remains loadable so in-flight items keep their workflow; there is no automatic migration. A human may move an eligible
  stopped item or an item paused in its planning stages with an explicit restart into the new workflow, which requires
  a fresh plan approval. The restart supersedes planning and later evidence from the prior workflow; existing
  construction items are otherwise unaffected.
- Implementation follows interface-first: extend the existing `PlanningCommands`/`PlanningRevisionInput` and the
  planning evidence rules. The existing restart controller also handles prior-workflow stage invalidation; no new
  resource kind, controller or port is added.

## Consequences
- Expected revision time drops from about four minutes to one planner run plus one review. The planner can read the
  code, which removes the hand-off gaps behind "files not read" findings and cross-artifact contradictions.
- One run carries more responsibility and a larger prompt. Output checks, the independent review, human approval,
  the Unit barrier (ADR-0047) and verification remain separate safeguards. If plan quality regresses, a workflow can
  still declare the old chain; both shapes are valid planning workflows.
- Agent definitions gain a `planner` agent; AGENTS.md (X30), glossary and architecture document the new workflow and
  answer withdrawal.
- Exit tests: eligible legacy planning items migrate only by explicit restart, with old planning and later evidence
  superseded; all four artifacts from one planner run pass the evidence binding; artifacts mixed from different runs,
  simulated, replayed or superseded runs do not; a single output check failure reruns only the planner; one review
  round then human; withdrawing an answer removes it from intent, records the withdrawal, restarts planning and shows
  it to agents as not binding; `factory-planned` items continue unchanged; approval binding and the plan gate are
  unchanged.

## Alternatives considered
- **Keep the chain and rerun only affected stages:** saves time per answer, but keeps five hand-offs, their
  inconsistencies and the provenance chain, and needs a dependency model of which answer affects which artifact.
- **Run the chain's agents in parallel:** the artifacts depend on each other, so parallel runs contradict each other.
- **One run without independent review:** faster, but loses the second opinion that catches real gaps.
- **Delete stale answers silently or let agents ignore them:** loses the audit trail, or lets agents override humans.
