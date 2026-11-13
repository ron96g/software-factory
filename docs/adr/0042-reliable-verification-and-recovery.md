# ADR-0042: Reliable verification and evidence-driven recovery

- **Status:** Accepted (phased implementation; X23a first)
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0005, ADR-0006, ADR-0012, ADR-0019, ADR-0027
- **Supersedes:** ADR-0023 check caching/failure policy and ADR-0027 verification evidence rules,
  only for workflows migrated to this contract. Their publication behavior and other decisions remain unchanged.

## Context
The factory currently runs repository check commands with a fixed 15-minute timeout, caches their results in memory,
and returns to implementation for any nonzero exit. Failed check output is not an explicit developer input.
An interrupted or slow monorepo suite can therefore consume the code-fix budget without identifying a code defect.
An agent can also report exit zero for a command that masks a failing test behind a pipeline or a later command.
Checks without implementations currently pass with a warning, and a verifier's partial verdict does not establish
which mandatory acceptance evidence is missing.

The investigated follow-up demonstrated these weaknesses: a full-suite timeout before the affected module,
an uninvestigated envtest setup failure, and focused tests insufficient to prove the acceptance criteria.
The response must improve factory workflow behavior across repositories, not patch that feature or silently
reduce its required verification.

## Decision
### 1. Establish an approved verification contract
- Produce a structured `validation-plan` artifact alongside the specification, before implementation. The
  architect/verifier maps acceptance criteria to named checks, required integration scenarios, prerequisites,
  focused versus full-suite scope, budgets and any evidence requiring human/external verification.
- Repository/workflow policy defines the allowed checks and minimum evidence. An agent proposes a plan; it cannot
  remove mandatory checks, invent authoritative results or grant itself additional execution capabilities.
  Spec-review approves the exact plan revision as well as the specification. An invalid or incomplete plan cannot
  start the verified construction path. Material scope or policy changes require renewed review.
- Budgets and environment requirements are explicit operator-reviewed configuration, not inferred from arbitrary
  model output. Affected-module selection may reuse a repository's CI dependency graph, but must preserve declared
  dependent-module/integration coverage and mandatory full-suite checks. Narrow tests do not replace them.

### 2. Persist each named check as a job
- Introduce `CheckRun`, a namespace-scoped runtime resource, owned by its WorkItem. Its immutable `spec` pins the
  check name, repository/check definition versions, approved plan revision, workspace identity, tested code snapshot,
  execution environment, budget and attempt identity. Commands come from validated repository policy or a registered
  check adapter, not an unrestricted command string supplied by the verifier.
- The CheckRun controller alone writes lifecycle/results through `StatusWriter`. Pending, Running, Completed and
  Interrupted executions are distinct from their result classification. Deterministic names deduplicate submission
  by item/stage/round, check, workspace snapshot and explicit attempt; optimistic concurrency guards transitions.
- Narrow submit/read/log ports serve both workflow gates and a recorded agent `run_check` tool. All authoritative
  verification goes through the same runner. General `run` remains useful for exploration, but its output cannot
  substitute for required CheckRun evidence. JSON mode cannot manufacture a successful check.
- Persist command identity, start/finish times, exit code, termination signal/reason, duration and evidence references.
  Keep complete redacted logs in a namespace-scoped append-only log, referenced from CheckRun, using the existing
  transcript storage pattern rather than an unmodeled database object. UI/prompt excerpts are bounded and visibly
  truncated; storage limits must report incomplete evidence instead of claiming complete logs.
- Restart recovery reuses completed evidence only when its input fingerprint still matches. Observe an existing
  execution if the runtime supports it; otherwise record it as Interrupted and schedule an explicitly bounded new
  attempt. A restarted factory never treats a vanished process as a pass or repeats it indefinitely.

### 3. Classify outcomes before choosing recovery
Use typed process termination metadata and registered test adapters where available, not an LLM interpreting a tail:

| Result | Required workflow response |
|---|---|
| Passed | Satisfies only the named evidence requirement for the tested snapshot. |
| AssertionFailed | Give the developer structured failures/log references and enter the bounded code-fix loop. |
| SetupFailed / Unavailable | Bounded environment recovery, then durable human attention; no speculative code rewrite. |
| TimedOut | Inspect progress, scope and budget; bounded retry or human budget review, not automatic implementation. |
| Cancelled / Interrupted | Recover execution or request a bounded rerun; do not charge the code-fix budget. |
| UnknownFailure | Preserve diagnostics and request attention rather than guessing that code is wrong. |
| NotVerified | Required check is absent, skipped, unsupported or lacks usable evidence; never a pass. |

- A generic nonzero exit is UnknownFailure unless structured evidence establishes a more precise classification.
  Exit 137 alone is not proof of OOM or timeout. Missing implementations remain explicitly NotVerified.
- Separate bounded execution/environment retries from code-fix rounds. Persist retry time, attempt budget and
  failure signature so restart does not reset them. Repeated identical outcomes without relevant code/environment
  change escalate rather than repeatedly spending model calls or running the same expensive command.
- Human intervention uses durable Clarification/Approval resources and visible conditions, not in-process waiting.
  Collect environment details or revised budget decisions without silently changing the approved contract.

### 4. Prepare the real environment and preserve command truth
- Preflight runs before implementation in the same workspace/runtime/profile used by the planned checks. It verifies
  required tools, test assets, dependencies, supported targets and execution capacity. Remediation commands, when
  authorized, run only through sandbox capabilities; factory credentials are never copied into that environment.
  Recheck relevant prerequisites if the environment changes.
- Prefer repository-supported Makefile/CI targets that prepare their test environment. Use named check adapters
  with validated arguments and fail-fast/pipefail execution. Preserve each required subprocess's outcome: setting
  pipefail alone does not prevent a later successful command from hiding a previous failure.
- An implementation agent receives the failing check identity, affected criteria, tested revision, structured test
  failures and bounded redacted excerpts with full-log references. Environment failures do not masquerade as code
  feedback. The verifier evaluates evidence against the plan instead of independently deciding what is sufficient.
- Serialize checks that mutate the same workspace, or execute them against isolated copies of a frozen candidate.
  Fingerprint the actual tested tree, including relevant uncommitted/untracked files, not merely its base commit.
  Generation/formatting that changes candidate code invalidates earlier evidence/review and requires revalidation;
  it cannot silently alter an already reviewed candidate during final verification.

### 5. Enforce evidence without bypassing humans
- Required evidence must be present, current, from real eligible runs and bound to the approved plan and candidate.
  Replayed, superseded or simulated output cannot satisfy real verification. Optional checks may be NotVerified,
  but must be explicitly optional under policy and remain visible.
- A partial verifier report lists unresolved requirements. Required missing/stale evidence blocks the verified path;
  free-text confidence cannot clear it. A structured result, evidence eligibility and gate grading are separate facts.
- Where policy permits an exception, a human must explicitly waive named requirements with Principal, reason,
  plan/check/candidate revisions and durable audit evidence. A waiver is displayed as Waived, never Passed.
  Changes to those revisions invalidate the waiver. Non-waivable requirements remain blocking.
- Preserve existing human gates. A verification decision or waiver is not publication permission. Unresolved
  verification cannot enter a publishing stage; this is important because ADR-0023 publishes on stage entry,
  before ship approval. This ADR does not add Git configuration, enable pushes or change merge/deployment policy.
- Check/log/event persistence failures are visible factory-infrastructure errors, not test assertion failures.
  Recovery must retain completed work without silently dropping audit evidence or rerunning the business agent
  merely to retry result publication.

### 6. Roll out in independently verifiable phases
1. **X23a: Check execution and evidence.** Narrow ports, CheckRun lifecycle, structured termination/outcomes,
   per-check budgets, durable results/logs and UI visibility. No acceptance criterion is yet declared enforced merely
   because a runner exists.
2. **X23b: Evidence-driven recovery.** Failure classification, separate retry budgets, durable attention states and
   developer failure input. Regression coverage proves timeout/cancellation do not trigger code-edit loops.
3. **X23c: Approved plans and preflight.** Planning at spec-review, shared agent/gate runner, environment preflight,
   workspace evidence freshness and enforcement/explicit waivers of required evidence.

Introduce the verified path through a registered gate/runner and explicit workflow policy, not a core switch by
repository or workflow name. Keep legacy definitions/version identity available during migration. Existing items
never automatically restart, rerun checks, reinterpret approvals or publish after deployment; an operator explicitly
chooses migration with fresh plan review. Historical warnings and simulated passes remain labelled legacy evidence,
not retroactively upgraded to verified results.

## Consequences
- AGENTS.md X23a-c record the phased increment; glossary and architecture distinguish it from the running legacy
  check implementation. ADR-0023/0027 record the scoped supersession; legacy workflows retain their existing behavior
  until explicitly migrated.
- CheckRun requires the normal kind registry, model, admission/schema, namespace/ownership and controller integration.
  Implement ports first and register capabilities in the composition root. No external workflow engine or new
  infrastructure service is required. Log storage follows the recorded, redacted append-only pattern.
- Evidence collection may cost more storage and broad checks may need longer explicit budgets. Bounded execution,
  retention and visible incomplete-log states are required; this is not unlimited execution or silent data loss.
- X23 is independent of proposed ADR-0041: retrospective feedback can later consume check evidence, but is not
  required to enforce verification, and support counts never grant an evidence waiver.
- Exit criteria include masked pipeline failures, setup failure with zero tests run, a slow but progressing suite,
  cancellation/restart recovery, no repeated code loop for unchanged infrastructure errors, namespace isolation,
  concurrent submission deduplication, complete or explicitly incomplete redacted logs, stale candidate/plan/waiver
  rejection, missing required checks, simulated/replay exclusion, and unchanged publication permissions.

### X23a implementation boundary
- Human-confirmed standalone checks are available only on stopped (`Failed`, `Done`, `Closed`) WorkItems with
  a Ready owned workspace and no active agents/checks or unhandled restart. Existing restart/replay actions refuse
  active standalone checks. Submission pins one configured Repository check, definition/profile/runtime versions,
  workspace UID and a hash of tracked plus non-ignored untracked file contents, deletions, symlinks and executable bits.
  Symlinked parent-directory escapes are rejected. Only named configured checks are accepted; the UI cannot submit shell.
- Deterministic names use the WorkItem name and human request ID. The same principal/input retry returns the original
  job without recapturing a changed workspace; conflicting reuse is rejected. Pending is represented by absent status.
  The controller executes once in-process and marks an orphaned Running job Interrupted after restart; a human must
  explicitly request another attempt. Completed results/logs survive restart without changing workflow state.
- Repository checks accept the existing command string or `{command, timeoutMs}` (1 ms to 24 hours; default 15 minutes).
  Commands execute through the sandbox with fail-fast and pipefail. This improves ordinary failing pipelines, but is
  not a parser guaranteeing the semantics of arbitrary shell conditionals; structured subprocess adapters remain later work.
- Logs are redacted and appended after command completion using transcript storage. The existing runner caps each
  output stream at 64 KiB; truncation and interrupted execution visibly mark logs incomplete. These are durable
  excerpts, not a claim of complete streaming logs. A missing or changed candidate cannot produce Passed evidence.
- Generic nonzero exits remain UnknownFailure; explicit timeout, signal and runtime failures are distinct. No
  assertion/setup classification is guessed from text. Approved plan identity, the agent tool/shared gate path,
  recovery budgets and required-evidence/waiver enforcement belong to X23b/c. Legacy gates retain their cache,
  routing and unsupported-check warnings; standalone Passed results do not approve them or advance the item.
- No Controlplane feature edits, failed-item restart, real check submission or publication is part of this rollout.

### X23b/c implementation boundary
- The opt-in `factory-verified` workflow preserves human specification, code-review and ship gates. The validation
  plan is JSON with `criteria[{id,description,checks}]`, `checks[]` and `preflight[]`; identities are `repository/check`.
  Repository policy supplies mandatory/waivable checks and preflights. A real, current planning run must have consumed
  the current specification. Plan approval binds specification/plan revisions, compiled workflow versions and repository
  versions; a later candidate approval binds actual workspace contents and runtime/profile identity.
- Both gate and recorded agent tool schedule immutable CheckRuns. Explicit exit/timeout/signal metadata takes
  precedence over registered structured result classifiers. Generic failures stay UnknownFailure. The Go JSON
  classifier requires genuine per-test failure events and complete evidence; package-only failures are not assumed
  assertions. Failed preflight commands are SetupFailed. Legacy shell exploration is not authoritative evidence.
- Execution attempts and retry times are reconstructed from durable jobs per stage/round/check. Only AssertionFailed
  consumes the bounded code-fix counter; other failures use the separate execution budget, then a durable Clarification.
  Answering it is an explicit new human attempt, not an automatic reset. Check-failure excerpts and log references
  reach developer contexts. Agent requests have the same execution bound and cannot exempt an unrelated/recreated caller.
- Required missing, stale, simulated or incomplete evidence blocks the verified path. A policy-permitted waiver is a
  separate Approval naming exact missing checks and requiring an explicit human reason. It binds the plan, candidate
  and evidence revisions, is audited as Waived (never Passed), and cannot waive pending or non-waivable requirements.
  Publication checks this evidence again before enqueuing any outbound effect.
- Explicit migration of a stopped item preserves its workspace/history, supersedes later output, restarts at validation
  planning and sets `spec.publicationDisabled`. That hold stops stage-entry publication and cannot be lifted by an
  approval, restart or agent. Existing items never migrate automatically. Resumption of the investigated item requires
  fresh human plan review; it does not authorize a push or waive missing evidence.
- Check and loop events before the latest verified restart remain historical timeline entries, not current gate
  blockers. Current AI review blockers still require an explicit override with a reason; evidence waivers are
  separately guarded against their exact missing requirements.
- Commands still use bounded append-only log excerpts with visible incompleteness, not unlimited/streamed logs.
  The verified path rejects incomplete required evidence. Full Controlplane build/test targets remain required with
  reviewed 30/60-minute budgets; a separate focused target does not replace them. Named preflight uses supported
  Makefile preparation and envtest assets, never a speculative source-code fix.
- Generated resource names now use a larger random suffix and bounded collision retry. An audit failure after
  persisting a successful AgentRun is reported as infrastructure failure without flipping the completed run to Failed
  or re-executing the agent.

## Alternatives considered
- Increase one repository's timeout: may unblock one run but preserves blind retries, missing evidence and masking.
- Tell agents to test more carefully: useful guidance, not enforceable execution or evidence.
- Let the verifier choose smaller tests until green: weakens acceptance without reviewed authorization.
- Send every nonzero exit to the developer: conflates assertions, environment failures and cancellation.
- Keep evidence only in events/in-memory maps: loses structured identity and recovery state across restart.
- Use only a final result artifact: does not model an in-flight job's lifecycle, interruption or durable retry policy.
- Implement retrospectives first as the solution: improvement proposals cannot replace verification enforcement.
