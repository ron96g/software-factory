# ADR-0041: Evidence-backed agent retrospectives

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0002, ADR-0005, ADR-0012, ADR-0030, ADR-0039

## Context
Agents encounter missing context, unavailable tools and ineffective workflow steps, but these observations do not
currently accumulate into reviewable improvements to the factory. Multiple agents reporting the same friction may
justify investigation, but their agreement is correlated evidence, not proof: agents can share a model, context
and mistaken assumptions.

Knowledge entries (ADR-0030) capture human-approved reusable facts. Retrospective observations are different:
they are unverified claims about how the factory could improve. Treating them as knowledge or instructions would
allow errors and prompt injection to influence future agents. Definitions remain Git-managed, and changes still
require human review. "Self-improvement" here means improving factory definitions and tooling, not model training
or agents silently rewriting their own instructions, permissions or approval gates.

## Decision
### 1. Capture observations as resources
- Introduce `RetrospectiveFeedback`, a namespace-scoped runtime resource using the normal KRM envelope.
  X22 initially targets `Workflow` definitions and their stages. Agent/Skill targets are later extensions.
- An opted-in agent may return a bounded optional feedback collection alongside its normal result. Each entry
  identifies a target stage, issue code, observation, impact, suggested improvement and supporting or contradicting
  evidence. Most runs produce no feedback. Positive observations and counterevidence are retained too.
- The factory validates the target against what the run actually used and attaches reporter identity/role, WorkItem
  and AgentRun UIDs, execution mode, timestamp and definition versions. Agents cannot select another reporter,
  assert eligibility or assign themselves support counts.
- Capture actual root/subworkflow versions during compilation/execution. Current run provenance records Agent and
  Skill versions but not the complete compiled workflow chain; looking up today's definition after a run is not
  sufficient. Legacy observations without verified versions remain inspectable but cannot qualify automatically.
- Persist candidates with the run's completion record, then reconcile feedback creation with deterministic names
  derived from run UID and candidate index. Capture failures are visible and recover from persisted candidates;
  they do not rerun the business agent or change the originating item's outcome merely to retry feedback storage.
  Failed runs can contribute controller-observed failure evidence, clearly distinguished from agent-authored reports.
- Feedback `spec` holds immutable observations and bounded, redacted historical evidence. Only its controller
  writes derived `status` through `StatusWriter`; human disposition is a separate audited spec field.
  Feedback has no cascade owner or required live dependency on its origin. Missing origins and truncated evidence
  are explicit, and deleting/recreating a name cannot replace the captured UID or evidence.
- Raw feedback never enters ordinary agent context or knowledge search. Retrospective agents receive it as
  untrusted reference evidence, not executable instructions. LLM calls and tools remain transcript-recorded.

### 2. Aggregate support deterministically
- Group by namespace, target definition identity/version, stage and an operator-defined issue code. Codes must
  distinguish actionable symptoms, such as missing repository context versus missing ticket history, rather than
  combining every "missing context" complaint. Unknown codes remain visible but ineligible for automatic grouping.
  An LLM may suggest related reports; only human-reviewed classification can move them into an eligible group.
- Call the trigger a **support threshold**, not an authorization quorum. Initial operator-configurable defaults:
  three distinct WorkItem UIDs in a rolling 14-day window and at least two reporting agent roles.
  Each WorkItem contributes at most one support count per issue, regardless of retries, delegations or report volume.
  Role diversity is calculated from eligible reports with factory-attached identities, not agent-declared votes.
- Replayed, superseded and simulated runs do not count automatically. Controller-only failure observations,
  positive observations and counterevidence do not count as supporting agent reports. Retain them for analysis.
  Reconcile eligibility when source state changes; proposals disclose the exact evidence and eligibility snapshot.
- Policy is operator-managed and versioned, not editable by reporting agents. Show the policy, window, counts,
  distinct origins, exclusions and counterevidence. Show exposure denominators only when measurable; a count is
  not a fabricated failure rate or statistical confidence.
- A human may start a retrospective below threshold. Meeting the threshold authorizes investigation only,
  never a definition edit, tool grant, approval override or external publication.

### 3. Investigate in a separate workflow
- A level-triggered retrospective controller creates a normal WorkItem using `factory-retrospective`, with an
  internal source, immutable bounded evidence snapshot and a deterministic key per issue/version and review cycle.
  Additional reports link to that investigation; no separate aggregate or proposal resource kind is needed.
- The workflow is read-only and proposal-only: analyze evidence, write an `improvement-proposal`, challenge it
  with a different reviewing agent, then await a durable human Approval. Reject returns to proposal drafting with
  bounded retries; humans can close or defer the item without applying a change. It has no `publish` stage.
- The proposal identifies the suspected cause, supporting and contradicting evidence, exact target versions,
  suggested change, risks, acceptance tests and a measurable expected benefit. External outages or isolated errors
  may correctly lead to a recommendation of no factory change.
- Approval is bound to the reviewed proposal/evidence revision. New evidence is visible as newer than that snapshot;
  changed proposal text or invalidated supporting evidence requires refreshed review. Historical approval never
  authorizes applying a proposal to a different definition version.
- Persist investigation linkage, disposition and cycle on feedback so restarts, duplicate events, deletion or
  rolling-window boundaries cannot create repeated investigations. A new cycle after rejection/deferral requires
  an explicit human action or materially new eligible origins after an operator-defined cooldown, not the same
  reports reaching the threshold again. Snapshot membership prevents concurrent reconciles claiming them twice.
- Collection or investigation failures appear as warning events/conditions with retry information. They do not
  block the originating workflows. Retrospective runs are excluded from automatic feedback triggers in X22,
  preventing a retrospective from recursively creating retrospectives about itself.

### 4. Keep implementation and publication separate
- A human can create an independent implementation follow-up against the factory repository using ADR-0039.
  It inherits reviewed historical context, not approval authority, and receives its own workspace, tests and gates.
- X22 performs no automatic definition edits, commits, pushes, PR creation, merge, deployment or hot reload.
  The existing `factory-loop` publishes on entering `ship` (ADR-0023), before its ship approval. A human starting
  an implementation follow-up must explicitly authorize that publishing behavior; retrospective approval alone
  must not automatically start it. A future automatic handoff requires a separately reviewed pre-publication gate.
- Changes to architecture, human gates, permissions or support policy retain their normal human/ADR requirements.
  All external effects continue through the outbox; agents cannot vote safeguards away.

### 5. Separate acceptance from demonstrated improvement
- Record proposal approval, implementation/merge, the new definition version actually loaded, and observed benefit
  as separate facts. Definitions still load at startup; a merged change is not proof the running factory uses it.
- Compare subsequent eligible runs with the original symptom and target version, reporting sample sizes,
  counterevidence and inconclusive results. Old-version reports remain history, not support against the new version.
  A human records verification or regression evidence; automated effectiveness scoring is deferred.

## Consequences
- AGENTS.md X22 tracks implementation. The glossary and architecture distinguish retrospectives from existing
  knowledge and monitoring feedback.
- Implement narrow capture, query and aggregation ports first, register the kind and extensions in the composition
  root, and preserve namespace scope, optimistic concurrency and controller status ownership.
  `RetrospectiveFeedback` is the only new resource kind; no new dependency, policy/aggregate kind or agent-accessible
  mutation tool is required.
- X22 covers workflow feedback, deterministic support, a proposal-only workflow with human review, manual follow-up
  and a Retrospectives view showing evidence, counts, disposition and verification links. Agent/Skill targets,
  semantic auto-clustering, automatic patching/publication and model training are outside this increment.
- Exit criteria: run-time workflow provenance is pinned; duplicate capture/reconciliation is idempotent; retries,
  replays, superseded/simulated runs and repeated reports cannot inflate support; mixed versions/namespaces never
  group together; threshold crossing creates one investigation; human review survives restart; original items and
  publication permissions stay unchanged; source deletion preserves evidence; rejected cycles do not hot-loop.
- The original ADR change recorded the proposal only; acceptance and implementation follow below.

### X22 implementation boundary (2026-11-14)
- Accepted for implementation at the project owner's direction. `RetrospectiveFeedback` is registered as an
  independent runtime kind. Triager, code-researcher and reviewer opt in through `Agent.spec.retrospectiveFeedback`.
- Agent results allow at most three observations, with four evidence-text fields bounded to 1,500 characters each;
  malformed observations produce durable Warning events instead of changing the business result. Candidate specs
  are persisted in the terminal AgentRun status and a separate capture reconciler retries resource creation.
  Failed runs with pinned workflow provenance also yield explicitly non-supporting controller observations.
  A synchronous store deletion guard checks every cascade member inside the deletion transaction: a run with pending
  evidence cannot be deleted until capture writes a content-bound metadata receipt. Capture/storage failure therefore
  keeps candidates durable and returns an explicit conflict on deletion rather than losing evidence.
- Scheduling pins the compiled root/subworkflow version map and the declaring workflow/stage. Capture requires
  equality with the execution-time map for automatic eligibility; legacy or changed chains remain inspectable.
  Reports initially target the reporting run's own stage. Missing/recreated origins cease counting, while captured
  evidence survives. Window aging does not retroactively invalidate a historical review.
- Operator configuration is `FactoryOptions.retrospectivePolicy`: a version, issue-code allowlist, minimum distinct
  origins/roles and window days. Defaults are three origins, two roles and 14 days. Unknown codes require human
  classification. There is no agent-accessible policy or feedback mutation tool.
- Automatic investigation runs once per namespace/target-version/stage/issue group. Subsequent cycles require an
  explicit human request; automatic post-cooldown cycles are not enabled in this increment. Snapshot membership
  and durable feedback links deduplicate concurrent/restarted reconciliation and prevent recreation after deletion.
  Up to 12 reports are captured per investigation, preferring distinct eligible origins/roles; truncation is visible
  and an automatic snapshot must itself meet the threshold. Positive observations and counterevidence remain visible.
- The internal, repository-free `factory-retrospective` workflow uses two distinct tool-free agents, produces
  `improvement-proposal` and `improvement-review`, and ends at a durable human `retrospective-review` gate.
  Proposal/evidence changes invalidate approval; restart from `analyze` obtains fresh AI and human review.
  Gate rejection/drift consumes a shared bounded two-retry review budget. Close/defer never applies changes.
- Human outcome records separate implementation references, loaded definition version and observed benefit/regression
  evidence. Implementation uses the existing manual follow-up flow; selecting a publishing workflow requires explicit
  publication authorization, recorded with the requesting principal. Proposal approval cannot provide that authority.

## Alternatives considered
- Reuse `KnowledgeEntry`: conflates an unverified complaint with approved reusable knowledge and its retrieval policy.
- Add a retrospective stage to every business workflow: couples process improvement failures to customer delivery.
- Let agents edit themselves when a majority agrees: correlated votes do not establish correctness or authorization.
- Create an implementation WorkItem for every report: creates noise and duplicate fixes without corroborating evidence.
- Use LLM similarity as the trigger: nondeterministic grouping can inflate support and is difficult to audit.
- Add dedicated aggregate, policy and improvement-proposal kinds now: derived grouping plus existing WorkItems,
  artifacts and Approvals cover the initial increment without a second workflow engine.
