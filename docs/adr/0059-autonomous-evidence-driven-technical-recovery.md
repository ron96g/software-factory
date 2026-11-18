# ADR-0059: Autonomous, evidence-driven technical recovery

- **Status:** Proposed
- **Date:** 2026-11-15
- **Deciders:** project owner
- **Supersedes on opt-in:** ADR-0042 and ADR-0047 technical-failure escalation and readiness-tool restrictions
  only; their evidence, completeness, approval and publication safeguards remain unchanged
- **Extends:** ADR-0055, ADR-0057, ADR-0058

## Context
The owner requires as little human involvement as possible. Routine debugging, failed tests and execution recovery
are factory responsibilities. Humans retain consequential decisions, authorization and the existing review gates;
they should not have to answer "try again" to restart the same investigation.

Investigation of `followup-651dcc78-2987-4854-a1bd-8fb43b27785d` found four developer attempts consuming 95 model
steps on Unit U1. The item stopped twice for guidance, while U2 and U3 never started. Only preflight had a formal
CheckRun; implementation testing used shell commands, sometimes masking failure exit codes behind output filters.
The prompt described `run_check`, but the tool was not offered to the developer.

The failures exposed incorrect asynchronous test assumptions. `readonly-tools.test.ts` expected a reviewer to have
finished as soon as the item entered `spec-review`; `sandbox.test.ts` dereferenced an Approval before it existed.
A delayed fake reviewer reproduced Running with no Approval, followed by reviewer completion and AwaitingApproval.
Additional catalog work exposed the race; removing it or caching Git reads changed timing, not the required state.
This diagnosis does not establish that the unfinished parser/catalog implementation is otherwise correct.

Recovery context also lost continuity: `previousAttempt` identified the new Running attempt instead of the latest
completed attempt and its diagnosis. The agent repeatedly rediscovered failures and tried speculative changes.
The completeness barrier correctly held unfinished work. The recovery path, not the barrier, needs improvement.

## Decision

### 1. Minimize human work without weakening authority
- Autonomous technical recovery is the default on workflows explicitly opted into this contract. It repairs within
  the approved scope, observes real evidence and retains all human plan/design/code/publication gates. It never
  approves a plan, answers a human decision, waives evidence, changes permission or publishes on the human's behalf.
- A failure or exhausted retry count alone is not a human question. Ask only when progress requires an identified
  human-only decision, authorization or resource the factory cannot obtain through its permitted capabilities.
  Consolidate these into one durable Clarification with the exact need, evidence, options and recommended action.
  "Debug this", "fix Git" and "answer to retry" are not sufficient questions.
- Transient unavailability uses the existing WorkItem Waiting phase, visible conditions and a persisted retry time
  with bounded backoff, not a new phase or an in-process wait. When authorized recovery is exhausted and no
  human-only action is identified, stop visibly as Failed with a technical recovery report, not a speculative
  Clarification or an approval of incomplete work. An operator may inspect the report and explicitly allocate a new
  bounded recovery allowance as defined below; ordinary answers, process restarts and model suggestions cannot reset
  budgets.
- Reserve at most one additional attempt per episode for a resolved, validated human-only need, declared in the
  recovery policy and included in its hard total limit. An answer does not itself prove that a prerequisite changed:
  recheck the recorded need or validate the decision through its existing guard. Once satisfied, the controller may
  consume this reserve automatically, without asking the human again to "retry". Bind consumption to the episode,
  exact need and answer/evidence version. A repeat failure cannot spend the reserve twice or obtain another by
  renaming the need; it uses any remaining ordinary budget or ends in technical failure. Scope changes still require
  fresh planning approval and cannot use this reserve.
- Genuine new scope or changed approved obligations return to the existing planning review. Permission, credential,
  budget and policy changes remain operator-owned. A recovered item proceeds only to its next normal guarded step.

### 2. Preserve a durable recovery episode and prior evidence
- Add an optional, validated `Workflow.spec.recovery` policy for this opt-in path. Its definition version and budgets
  are recorded; the policy does not modify an already approved verification contract invisibly.
- Reuse WorkItem, AgentRun, Artifact, CheckRun, Event and transcript resources; introduce no new resource kind,
  free-form database record or separate mutable Unit ledger. The WorkItem controller alone records recovery progress
  through StatusWriter with optimistic concurrency.
- A recovery episode is bound to namespace, WorkItem UID, approved plan fingerprint, Unit or stage, triggering
  run/check identity and policy version. Controller-owned recovery status references the trigger and latest eligible
  report and records diagnostic attempts, execution/code attempts, retry time and terminal disposition.
  Deterministic run/job identities include episode and attempt; duplicate reconciliation cannot spend another try.
  Retried or newly submitted checks attach to their originating episode. Enforce an enclosing plan/Unit or stage
  hard limit across episodes so new trigger IDs or failure signatures cannot replenish diagnostic or repair budgets.
- A Failed-with-report item may receive an explicit recovery allowance through an existing Approval resource with a
  distinct typed `recovery-allowance` purpose. Its immutable request binds namespace, WorkItem UID, episode, latest
  report name/resourceVersion, plan fingerprint, policy version, allowance count and proposed resumption target.
  Requests include a caller-chosen stable `requestId`; identical retries return the same receipt, conflicting reuse is
  rejected, and a new ID permits a fresh request after rejection without resetting any consumed allocation.
  A server-authorized operator Principal decides it with a reason; count and target must remain within the policy's
  operator-allocation ceiling and approved scope. Agent tools cannot create or decide this Approval.
  The controller validates freshness and records single-use consumption before resuming the appropriate diagnostic
  or repair step. Concurrent/duplicate decisions cannot allocate twice; stale decisions are rejected and rejection
  leaves the item Failed. Historical consumption is never reset. This approval allocates execution only, not
  candidate approval, a waiver or publication permission, and is unnecessary while automatic budgets remain.
  The effective hard limit is the original allowance, including the human-need reserve, plus explicitly approved
  operator allocations, bounded by the policy's cumulative allocation ceiling; all consumed attempts still count.
- Separate current progress from prior evidence. Before every new run, provide the latest completed eligible attempt
  for this plan and assignment, its outcome, remaining obligations, report, relevant CheckRuns and full-log references.
  Never call the current Pending/Running run `previousAttempt`. Include a bounded history of attempted hypotheses,
  changes and results, with links to omitted history. Missing evidence is explicit, never an empty success-shaped value.
- Replays, superseded output and reports for another plan, owner UID or namespace cannot steer recovery as current
  evidence. Changed candidate snapshots make check evidence stale but do not erase the investigation or replenish
  the enclosing plan/Unit recovery budget.

### 3. Offer authorized check tools through the harness
- Extend the harness tool-offering policy through a narrow port and registered implementations, wired in the
  composition root. An operator-approved recovery policy may offer `run_check` to an assigned implementation or
  diagnostic run without adding it to an Agent definition.
- This is an explicit, scoped extension to ADR-0047's verifier-only agent-tool restriction, not permission to execute
  arbitrary commands. The server checks the current plan, assignment, stage, workspace ownership, repository
  readiness allowlist and remaining budget on every submission. Agent-provided commands, scope or budgets are rejected.
  Explicit step tool restrictions, including an empty list, remain ceilings; read-only roles never gain execution.
- Focused diagnostic checks or typed test selectors must be explicitly configured in the operator allowlist and
  validated by their registered check adapter. They may collect diagnostic evidence but cannot replace broader
  readiness/final checks. If no permitted reproduction exists, inspect available logs/code and report the precise
  capability gap; do not invent a command or silently relax the required scope.
- Developer-submitted readiness jobs use the same scheduler, serialization, snapshot identity, complete redacted logs
  and eligibility rules as controller-submitted readiness jobs. Pin the Unit, producing attempt and plan; reconcile
  existing jobs rather than duplicating them at the gate. Such checks cannot substitute for final verification.
- Render concrete allowed check names, workspace aliases, submission/polling examples and available log-reading
  capabilities in the tool guide. Do not describe a callable tool that was not actually offered.
  A running check is not a pass; an active mutating check excludes implementation writes and other workspace jobs.
- Shell commands remain exploratory. Preserve subprocess exit codes and termination metadata; bounded display
  excerpts reference complete logs rather than piping a failing command through a success-returning filter.
  Required evidence comes only from eligible CheckRuns, never from model prose or a green filtered shell result.

### 4. Diagnose before repeating, with typed reports
- On an incomplete Unit or failed check, retain the original evidence and enter a bounded diagnostic path instead
  of immediately rerunning the same implementation prompt. Default to at most two diagnostic AgentRuns per episode;
  existing approved execution and code-fix budgets remain separate and are not increased by this decision.
- Use the existing developer Agent for diagnostic runs, with a policy-pinned assignment and tools narrowed to
  workspace reads/search and authorized non-mutating named diagnostic checks. No Agent-definition edit is required.
  Diagnostics cannot write candidate files or run arbitrary shell commands. Repair is a separate execution or
  code-fix attempt under its corresponding budget. Read-only research roles remain read-only.
- Diagnostics inspect the exact failed assertion, lifecycle predicate, command, tested snapshot and relevant code;
  use a focused reproduction before another full suite. In particular, stage entry is not stage completion.
  Baseline comparisons use a separate permitted sandbox snapshot, never stash/reset the shared candidate or discard
  work to obtain a baseline. Narrow exploratory tests do not satisfy broader required checks.
- A segregated baseline-preparation port, registered at the composition root, owns isolated snapshot creation and
  cleanup through an authorized ExecutionEnvironment. Preparation is an execution-budgeted operation, with pinned
  input and recorded provenance; it may not mutate the shared candidate. Checks that generate candidate files are
  execution attempts, not read-only diagnostics, and retain ADR-0047 workspace serialization and drift guards.
- Define `recovery-report` as a versioned, strict JSON Schema ArtifactType before enabling the path. It contains
  typed trigger/evidence references, observed failure signature, facts versus hypotheses, attempted actions and their
  results, remaining obligations, recommended next action, and any specific human-only need.
  Check/report references pin exact versions; code evidence pins the tested snapshot and location.
- Use the same schema/domain checks at `finish` and after execution. Actionable validation errors reach the producer
  for bounded in-run repair under ADR-0055/0057. Invalid reports never authorize recovery; correction exhaustion is
  visible and counts against a hard episode limit rather than creating an unlimited diagnostic loop.
- The report is a proposal, not authority. Registered routing validates its evidence and allowed action against
  authoritative process/check metadata and the approved contract. AssertionFailed may lead to a bounded code fix;
  setup, timeout, cancellation, interruption and UnknownFailure first require appropriate diagnosis or execution
  recovery. A model cannot relabel UnknownFailure as AssertionFailed or fabricate a successful test.
- Compute failure signatures from persisted check/test/termination evidence, not model text alone. Compare them with
  the candidate/environment identity and recorded diagnostic actions. An unchanged signature without new relevant
  evidence cannot start another blind code-fix run or full-suite rerun. It routes to an unused diagnostic attempt,
  permitted backoff, a genuine human-only need, or terminal technical failure.
- Stable signature inputs are the named check, authoritative outcome, exit code/signal and any registered structured
  test/assertion identity. Free-form messages, elapsed time, temporary paths, model wording and caller/job IDs are not
  signature inputs. Citing a previously unseen check is insufficient progress: new repair evidence must concern the
  same failing required check and demonstrate a distinct authoritative failure, not merely a new candidate snapshot
  or unrelated diagnostic/baseline result.
- Relevant new evidence can justify the next action only within remaining budgets. Snapshot churn, changed wording,
  a newly created caller, an ordinary answered clarification or restart cannot manufacture a fresh allowance.
  The single policy-reserved human-need attempt and an explicit operator allocation above are the only exceptions;
  neither resets historical counters. Recovery
  status and attempt accounting survive crashes, duplicate delivery and result-validation retries.
- Diagnostic AgentRuns and authorized diagnostic/baseline CheckRuns consume the enclosing hard-total allowance.
  Named diagnostic jobs additionally obey the existing execution-attempt budget. This can exhaust the remaining
  allowance before a repair; submitting checks does not create a separate unbounded diagnostic pool.

### 5. Keep safety, completeness and observability intact
- Only one mutating agent/check operates on an item workspace at a time. Recover uncertain executions from recorded
  state before starting another. Diagnostics never move the candidate into review or publication.
- Completing diagnosis is not completing a Unit. Actual implementation evidence and every named readiness check
  must satisfy ADR-0047's barrier on the current candidate, followed by independent review and final verification.
  Malformed, partial, missing, stale, simulated, replayed or incomplete evidence is never a pass.
- Every model/tool/delegation interaction is recorded and redacted. A report/log persistence failure is a visible
  infrastructure failure, not permission to rerun completed business work or silently drop evidence.
- The item page distinguishes autonomous diagnosis, repair, Waiting, terminal technical failure and a genuine human
  decision. Show the latest failure, tested revision, attempt budget, retained work and next action in one place.
  A technical failure must not be headed "The factory needs your decision" unless there is a specific decision.

### 6. Rollout and acceptance
Implement X39 in these slices, keeping autonomous recovery policy disabled until all exit criteria hold.
Slice 1 is independently shippable and need not wait for the new policy:
1. Correct asynchronous test predicates and test them with delayed agents and delayed Approval creation.
2. Preserve completed-attempt context; add the schema-backed report and durable, bounded recovery routing.
3. Offer scoped readiness checks through the harness, share evidence with gates and render accurate recovery UX.

Existing items and their pending Clarifications are not automatically answered, restarted or migrated on deployment.
Adoption is explicit at a safe stop with no active agent/check or outbound effect. Reconfirm affected policy/plan
bindings through the existing approval mechanism, retain workspace/history and historical budget consumption, and
apply a reviewed bounded allowance. Never fabricate historical reports or upgrade shell results to CheckRuns.

Acceptance criteria:
- **AC-39-1:** Delayed reviewer/Approval execution cannot cause stage-entry tests to assume completion.
- **AC-39-2:** A retry receives its completed predecessor's diagnosis; the current run appears only as current progress.
- **AC-39-3:** A reproducible technical failure is diagnosed, repaired and rechecked within policy without a human
  clarification; the next ordinary approval gate still requires its human.
- **AC-39-4:** Identical failures without new evidence, malformed diagnostic output, candidate churn and process
  restart cannot create unbounded runs or reset budgets; exhaustion stops with an actionable report.
- **AC-39-5:** Readiness check submission is recorded, deduplicated, serialized and snapshot/plan-bound; explicit
  tool restrictions, namespace boundaries, read-only roles and check allowlists cannot be bypassed.
- **AC-39-6:** Masked shell exits, missing/stale/incomplete evidence and a model's diagnosis cannot satisfy readiness,
  final verification or publication guards.
- **AC-39-7:** A real human-only blocker yields one consolidated, answerable request; a mere technical retry does
  not. Resolving the need consumes its reserve at most once without a second human retry request. Operator allowance
  decisions reject stale/unauthorized requests and deduplicate consumption. Adoption preserves historical state and
  requires no invented answer or automatic approval.

## Consequences
- Routine technical recovery consumes agent work rather than repeated human debugging. Bounded diagnosis may cost
  additional model calls, but replaces blind reruns and preserves previous discoveries.
- Human involvement is minimized, not promised to be zero: reviews, consequential decisions, permissions and truly
  unavailable resources remain explicit. Some unresolved technical failures will stop rather than cycle forever.
- AGENTS.md tracks X39 as in progress. The opt-in implementation leaves existing workflow definitions, live item
  state and publication permissions unchanged. ADR-0042/0047 retain their accepted behavior outside this opt-in path.
- On acceptance, mark ADR-0042/0047 as superseded in part for the opted-in technical escalation and readiness-tool
  policy; retain their original decisions and implementation history rather than rewriting them.
- Ports, policy/model schemas, report ArtifactType, admission, controllers, tests and UI must be implemented and
  reviewed together before enabling recovery. A prompt-only implementation does not meet the contract.

## Implementation status

The implementation includes completed-attempt context, strict `recovery-report` validation, durable recovery
episodes and counters, scoped named checks and log access, candidate/baseline execution contracts, runtime-need
validation, typed operator allocations, and recovery evidence on the item page. Named Node TAP checks can use the
registered `node-test-tap` classifier; setup, malformed or incomplete output is not assertion evidence.

Existing workflows are not opted in automatically. Adoption and production enablement remain on hold:

- No production runtime currently guarantees candidate-isolated diagnostic execution. The host adapter can prepare
  a separate pinned baseline checkout, but it is unsandboxed and cannot authorize candidate-isolated diagnostics.
  Unsupported operations fail explicitly; diagnostics must use available code/log evidence instead of an unsafe
  execution fallback. The available local Docker daemon is rootful and does not satisfy ADR-0019's rootless
  requirement; nonroot containers alone do not make that daemon eligible.
- Operator allocations require a non-anonymous `Principal` with the `operator` role and an explicit reason.
  `POST /api/workitems/{name}/recovery-allowances` requests an allocation with a stable `requestId`, `count`,
  `target`, and `reason`. Retrying the same request recovers its receipt; a new request after rejection needs a new
  ID, and reusing an ID with different allocation details is rejected;
  `POST /api/recovery-allowances/{name}/decide` accepts `decision` and `reason`. The current HTTP adapter uses an
  anonymous principal, so these endpoints cannot allocate execution in production until trusted authentication
  supplies operator authority. They cannot approve workflow gates or grant publication permission.

The ADR remains Proposed and X39 must not be marked complete until all acceptance criteria and architecture review
hold, including the required production capabilities. No existing clarification is automatically answered or item
restarted by deployment.

### Verified implementation

- TypeScript and the production build pass.
- All 271 tests, 28 composition-root integration tests, and 36 acceptance tests pass.
- The recorded tool-loop acceptance checks malformed-report self-correction, an actual file repair that changes
  failing readiness to passing, named CheckRun execution, zero Clarifications, and the ordinary undecided human gate.
  This uses a scripted model, manually composed public application services, and a fake sandbox; it is not a live
  model or production-isolation claim.
- Definition validation passes for 80 resources, with zero errors and three existing missing-check-command warnings.
- Architecture review passes with no blocking findings. Live adoption remains blocked by the capabilities above.

## Alternatives considered
- **Ask the human after each retry:** transfers discoverable engineering work to the owner and loses continuity.
- **Increase budgets or retry indefinitely:** repeats the same failure without establishing progress.
- **Automatically accept partial work or weaken checks:** defeats approved scope and evidence safeguards.
- **Add tools to every Agent definition:** couples harness recovery to role files and grants overly broad access.
- **Trust free-form diagnoses:** cannot enforce identity, routing, budget or evidence eligibility.
- **Patch only the two tests:** fixes the immediate race, but not lost retry context, inaccessible checks or human
  escalation for ordinary technical failures.


> Amended by ADR-0067: policy-declared waivers of pre-existing findings are allowed; stage-bound recovery episodes cover change-caused verify failures.
