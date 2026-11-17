# ADR-0047: Complete approved Units before code review

- **Status:** Accepted
- **Amended by:** ADR-0061
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Extends:** ADR-0024, ADR-0042, ADR-0043, ADR-0046
- **Changes:** the planned path's per-Unit execution deferral retained from ADR-0045 by ADR-0046

## Context
An approved plan contained multiple Units, but the planned workflow scheduled one developer run. The developer
reported that only one Unit was delivered; later runs fixed findings in that slice, and a reviewer approved the slice.
The verifier then reported that the remaining Units were absent. `AgentRun` Succeeded means execution finished, not
that the approved scope was delivered. A successful build, a model's completion claim, or a review of a partial diff
does not establish that all planned work exists.

The owner requires the factory to finish the approved Units autonomously before starting code review or verification.
It must stop with useful information when it cannot do so, rather than asking a reviewer to discover known omissions.
Planning and candidate approvals, verification, publication controls, sandboxing and recorded interactions remain
independent safeguards.

## Decision
Introduce an explicitly opted-in, sequential Unit execution contract for planned construction. This is
not generic `forEach` or concurrent Bolt fan-out. Other workflows retain their existing semantics.

### Approved execution scope
- Add a validated machine-readable Unit manifest (`units[]`) to the structured, approval-bound `validation-plan`,
  using the stable Unit IDs of the readable `units-of-work` artifact. Each required Unit has a stable unique ID, description, explicit dependencies, associated approved
  acceptance-criterion IDs, and concrete completion obligations. Each obligation names its intended implementation
  evidence and at least one configured, policy-permitted named readiness check applicable to that Unit. A check may
  cover multiple Units; a Unit may require several checks. Repository/workflow policy explicitly allowlists named
  readiness checks and budgets; the approved manifest maps that allowed subset to specific obligations. Neither an
  agent nor a plan can authorize arbitrary model-provided commands or checks outside the allowlist.
- Before plan approval, validate unique IDs, references, dependency acyclicity, nonempty obligations, criterion
  coverage and check configuration. Unmapped required criteria, unknown dependencies, absent checks and contradictory
  or ambiguous scope block approval; they cannot be silently dropped or inferred as satisfied. Decomposition,
  validation plan, human-readable delivery plan and manifest must agree. Material scope or obligation changes return
  to planning and require fresh human approval. The existing approval fingerprint binds the exact manifest, spec,
  validation plan, policy, workflow and human planning intent. Plan review must identify checks whose prerequisites
  include Units outside the Unit's dependency closure; use a suitable focused readiness check or change the
  dependency/plan before approval. Checks cannot be assumed to pass merely because the plan is valid.
- The approved plan identifies all required work, including cross-cutting and infrastructure Units. Exclusions are
  explicit and human-reviewed; no runtime skip, ordinary check waiver or partial approval removes a required Unit.
  If a required Unit cannot have an appropriate configured readiness check, revise the plan or configure the check
  before approval; an agent's prose or an unrelated green check is not a substitute.

### Sequential implementation
- Derive per-Unit progress deterministically from durable, owned AgentRuns (with their immutable assignment),
  Artifacts and CheckRuns, scoped by approved plan fingerprint and Unit ID. Retry counters stay in the WorkItem's
  controller-owned `status.retries`. Reuse these resources; do not introduce a new resource kind or a second
  mutable copy of progress that could drift from its evidence. Derived displays must distinguish pending, implementing, checking,
  ready and blocked; ready means ready for aggregate review, not independently verified or approved.
- Select the first pending Unit whose dependencies are ready, in approved plan order. Run only one mutating Unit
  attempt at a time in the shared item workspace. The developer receives the entire approved scope for context,
  the selected Unit and its obligations as its assignment, prior relevant findings and completed-Unit evidence.
  A successful AgentRun alone never marks a Unit ready. Record all tool/model interactions as usual.
- Dependency readiness uses the predecessor's recorded, eligible result and checks at its completed snapshot.
  Later Unit changes do not erase that historical progress or restart already completed Units merely because the
  aggregate snapshot changed. They do make earlier snapshot-bound checks stale for the final barrier, which reruns
  them. A failed rerun reopens the relevant Unit or a cross-Unit repair; it never silently restores readiness.
- A Unit attempt produces a structured result identifying the exact plan and Unit, complete/partial/blocked outcome,
  implementation evidence such as workspace paths and test references, and a disposition for every obligation.
  Only a real, current, non-replay and non-superseded complete result from the assigned attempt is eligible.
  Missing, duplicate, malformed, contradictory or partial results leave the Unit unfinished. The controller runs
  the declared readiness checks using the existing durable CheckRun mechanism and records their results. Checks
  execute in the authorized environment, not via a free-form command supplied by an agent.
- A Unit becomes ready only when all its obligations have eligible implementation evidence and required readiness
  checks have passed with complete logs against the recorded workspace snapshot. An agent's declaration, file-path
  citation or green check can still be wrong or inadequate: readiness is an auditable precondition for review,
  **not proof of semantic correctness**. Independent whole-candidate review and final verification remain necessary.
- Readiness jobs use a distinct `unit-readiness` CheckRun purpose, authorized at the configured implementation
  stage and carrying the plan fingerprint, Unit ID, attempt and workspace snapshot. Extend the existing CheckRun
  model, admission, scheduler and controller accordingly. Final-verification and waiver queries must exclude this
  purpose. The current verifier-only agent `run_check` cannot submit readiness jobs; the construction controller
  schedules only approved, allowlisted checks via the narrow scheduler capability.
- Every readiness job identity and deduplication fingerprint includes the WorkItem UID, plan, Unit, check, workspace
  snapshot and explicit attempt. Retrying the same identity returns its original job, even if failed or interrupted.
  A new execution, including a retry after failure or a new candidate snapshot, uses a new identity; it cannot
  recover a stale job as evidence for another snapshot. Execution attempts are bounded per plan/Unit/check/snapshot;
  the initial rerun on a new snapshot starts that snapshot's execution budget. Repeated unexpected drift during
  aggregate preparation/review is separately bounded by the candidate-drift budget; normal progress through
  planned Units does not consume it.
- Readiness retains ADR-0042's complete-log requirement. As a prerequisite, extend check logging to persist complete
  redacted output beyond the current 64 KiB capture cap, with explicit operator-configured resource limits and
  backpressure. Redaction must handle secrets spanning stream chunks. Truncation, storage failure or reaching the
  configured limit is visibly incomplete, never a pass; bounded recovery or human attention must explain the limit.
  Quieting or discarding output must not disguise incomplete evidence.
- Readiness checks are construction evidence, not final verification evidence. Some Unit checks may run before all
  other Units exist, so the plan must choose suitable focused checks; final integration, acceptance and security
  evidence remains governed by ADR-0042 and cannot be replaced by earlier Unit results.

### Pre-review completeness barrier
- Before candidate preparation or the first AI code-review step, independently evaluate the complete manifest against
  the persisted ledger. Every required Unit and obligation must have eligible evidence and every required readiness
  check must pass against the same current multi-repository candidate snapshot and approved plan. A check that
  covers several obligations can satisfy each only when explicitly mapped in the approved plan. Automatically rerun
  stale readiness checks on the final candidate; preserve historical intermediate evidence. Missing, stale, simulated,
  replayed, superseded, incomplete or inconsistent evidence is not ready. The aggregate candidate is the existing
  map of workspace identities to snapshot fingerprints; each CheckRun must match its own repository's entry and
  declared environment, while the barrier binds the entire map and approved plan.
- Once all Units are ready, run ADR-0043 preparation. If preparation changes the candidate, rerun affected readiness
  checks; until reliable impact analysis exists, rerun all required readiness checks on the resulting snapshot. Check
  the barrier again before any reviewer starts. Preparation is not rerun merely because readiness was rechecked;
  rerun it only when its own candidate binding is invalid. Wait for active workspace jobs and re-fingerprint the
  candidate immediately before review starts. An unplanned mutation invalidates the barrier and leads to bounded
  recovery, not review of an unexamined candidate. Bound repeated preparation/readiness drift using a durable
  candidate-drift budget; exhaustion requests human attention rather than cycling indefinitely.
- The barrier is server-side and applies to normal progression, direct stage restart, retries, human decisions,
  recovery and APIs. It cannot be bypassed by an approval override, a clarification answer or a missing ledger.
  It is a hard precondition, not an overridable `deriveGateEvidence` item. Evaluate it before preparation and before
  the first AI code-review step even when no preparation stage is configured; recheck it at candidate approval and
  verification entry. Approval and direct-entry APIs enforce the same guard, not just normal controller transitions.
  Starting verification additionally requires the existing fresh candidate approval and verification controls.
  An incomplete candidate cannot be sent to a reviewer merely because an execution or review retry budget expired.
- Reviewers receive the complete plan, Unit ledger and current evidence, and review the **whole candidate**, not just
  the latest Unit or fix. Existing bounded review-to-fix routing remains: findings are assigned to the affected
  Units, or to an explicit cross-Unit repair attempt if attribution is unclear. Repairs invalidate affected
  readiness evidence; conservatively invalidate all when impact cannot be established. Re-establish the complete
  barrier and obtain a fresh candidate review after a change. Verification failures follow ADR-0042 and likewise
  return through the barrier before another review.

### Recovery, persistence and UX
- A partial Unit remains active and is retried autonomously with its own missing obligations and diagnostics.
  Distinguish model unavailability, interruption, environment/check execution failure and code assertion failure:
  use separate bounded execution and code-fix budgets, following ADR-0042. A repeated unchanged failure, exhausted
  budget or unresolvable dependency creates durable human attention identifying the Unit, blocker, evidence and
  next action. It never advances or silently skips work. Answering a clarification resumes the appropriate bounded
  recovery; it is neither approval nor an unconditional reset of retry budgets.
- An Interrupted readiness check may be retried automatically as a new deterministic attempt within the execution
  budget after confirming no execution is still active; otherwise it stops for human attention. This scoped recovery
  does not alter the human-requested standalone-check policy.
- Use deterministic attempt and check identities, optimistic concurrency and level-triggered reconciliation.
  Persist attempt creation before execution, reconstruct progress after restart and deduplicate retries. If a
  mutating attempt was interrupted or its completion is uncertain, reconcile its recorded run and workspace snapshot;
  never assume it completed or blindly run it concurrently. If safe recovery cannot be established, stop for human
  attention. The current AgentRun controller's automatic re-execution of orphaned Running jobs must be changed for
  these opted-in mutating attempts so it cannot bypass this recovery rule. While a workspace job is active, only its
  authorized executor may mutate that workspace; readiness checks serialize with implementation.
- Show the approved Unit list, dependencies, current Unit, progress, evidence and actionable blockers in the planning
  workspace. Clearly label readiness checks separately from final verification. Report uncompleted scope before
  presenting any candidate-review control; do not create an approval that implies incomplete work is reviewable.
  Human interaction is exceptional and consolidated where practical, rather than a question after every Unit.
- Plan changes supersede the prior ledger and all dependent readiness and candidate approvals. Reuse historical code
  only as workspace state, not as proof for the new plan. Re-establish evidence under the new approved plan. Candidate
  changes similarly invalidate snapshot-bound evidence; a status flag alone cannot carry it forward.

### Rollout and existing items
- Implement behind explicit workflow policy with interface-first, narrow ports and composition-root registration.
  Do not reinterpret legacy `forEach`, change existing workflows automatically, or grant new sandbox capabilities.
  The opt-in path retains all existing human gates, outbox controls and publication permissions. Do not enable it
  until the complete redacted check-log capture prerequisite is available.
- Existing items, including the partially implemented live item, are not restarted or migrated on deployment.
  A human explicitly requests migration at a safe stop with no active agent/check or publication effect. Preserve
  workspace and history, hold publication, revise and approve a structured plan, and start with no inferred ready Units.
  Already-written code may be inspected and checked under the new plan; it is not automatically credited as done.
  Migration supersedes any pending candidate review and prior candidate approval; a fresh barrier and review are
  required. Migration, clarification answers and renewed plan approval never authorize publishing.

## Implementation (X27)
- `Workflow.spec.unitExecution { barrierStage, maxCodeAttempts, maxExecutionAttempts }` opts in; it requires the
  verified contract, a `unit-progress` gate on the implementation stage and a barrier stage that directly follows
  implementation and is the preparation stage. `Repository.spec.verification.readinessChecks` is the allowlist.
- `AgentRun.spec.assignment` (`unit` or `repair`, bound to the plan fingerprint) is set by a `StepAssignmentPolicy`
  when the WorkItem controller creates the run. The developer finishes with outcome `complete | partial | blocked`
  and a JSON `unit-result` artifact listing each obligation with workspace file evidence; paths are probed once.
- The `unit-progress` gate schedules `unit-readiness` CheckRuns (Unit, attempt run, snapshot and attempt in the
  identity) and returns to implementation for the next Unit, a code fix or a bounded retry. `CandidateCompleteness`
  runs inside the verification stage policy before preparation and every later stage and inside candidate/waiver
  approval validation, so overrides, direct restarts and agent `run_check` calls cannot bypass it.
- `RunFailurePolicy` turns an assigned attempt that the AgentRun controller found Running after a restart (marked
  `interrupted`, never re-executed) into a bounded new attempt. Execution budgets count per round, so an answered
  Clarification grants one new bounded attempt instead of re-blocking immediately; code-fix budgets do not reset.
- Infrastructure Units may list no criteria, but every criterion needs a delivering Unit. Operator-mandatory checks
  need no criterion mapping in the validation plan (policy already requires their evidence); optional checks and
  every criterion still need complete traceability. A gate attention stop is re-evaluated on resync, so a fixed
  cause resumes to the human review it would have created; it never approves.
- Check output capture defaults to 16 MiB per stream (`FACTORY_CHECK_OUTPUT_BYTES`); output is redacted as a whole
  before persistence. Agent tool commands keep the 64 KiB cap. Truncation remains visibly incomplete evidence.
- `UnitProgressQueries`/`UnitLedgerReader` feed `GET /api/workitems/{name}/units`, the item page's Units panel
  (shown above gate controls) and agent context: the assigned Unit for developers, the full ledger for reviewers.
- Addendum (live item, ten repair attempts): a real cross-Unit repair that ends `partial`/`blocked` without questions
  advances to the barrier and code review with a `RepairIncomplete` warning instead of retrying and then asking the
  human "answer to retry". Every Unit is already ready, so the open items are review findings; the review loop
  (bounded) and the human code-review gate already own them, and a nested retry loop produced repeated no-change
  attempts whose summaries came back as questions. Only simulated repairs still retry. Clarifications record
  `askedBy` (agent run or gate) and keep supporting text in `details`, so factory stops are not shown as agent
  questions and long summaries do not become question text; contentless answers to factory stops are not fed back
  into agent prompts.

## Consequences
- AGENTS.md X27 tracks the increment. Sequential Unit execution exists before v1.0 for the opted-in planned path;
  generic `forEach`, concurrent fan-out and independent Unit delivery remain later work. ADR-0045's deferral changes
  only for this path.
- Added manifest, attempt/result and status fields require schema/admission validation and exact-revision binding.
  Progress must be recoverable without relying on process memory. Readiness checks can add latency and compute;
  running all on the final candidate is intentionally conservative.
- This contract prevents **known or unevidenced omissions** from reaching code review. It cannot guarantee that a
  misleading agent report or inadequate tests capture the actual intent. Human plan approval, independent review
  and final verification still address that residual risk.
- Exit tests must cover: U2 complete while U0/U1/U3-U7 are absent; dependency ordering; partial, malformed,
  simulated and replayed results; missing and failed checks; candidate changes and preparation drift; stale plan
  or approval; retries and crash/concurrency recovery; repair loops; namespace isolation; migration of a partial
  workspace; every restart/API bypass, including a blocking-evidence override; same-identity deduplication versus a
  new snapshot or retry; readiness log output over 64 KiB and explicit limit exhaustion; and unchanged legacy
  workflows, human gates and publication holds.

## Alternatives considered
- **Improve developer/reviewer prompts only:** useful guidance, but cannot enforce complete scope.
- **Send each partial slice to the code reviewer:** makes reviewers discover omissions the factory already knows.
- **Run all Units concurrently:** introduces shared-workspace conflicts and recovery complexity before sequential
  correctness is established.
- **Treat a passing full suite as completion:** tests may not exist for omitted behavior.
- **Let a human waive missing Units at the review gate:** silently changes approved scope; use a reviewed plan
  revision instead.
- **Implement generic `forEach` now:** broader than the required sequential planned-construction contract.
