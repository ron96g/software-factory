/**
 * Typed spec/status shapes per kind.
 * Definitions mirror the YAML/Markdown in the repo. Runtime kinds live in the store.
 */
import type { Condition, DocumentResource, Ref, Resource } from "./resource.ts";

// ── Definitions ──────────────────────────────────────────────────────────

export interface AgentSpec {
  role: string;
  retrospectiveFeedback?: boolean;
  /** Required for agents with write/exec tools (ADR-0019). */
  sandboxRef?: Ref;
  model?: { tier?: string; providerRef?: Ref };
  skillRefs?: Ref[];
  delegates?: { agentRef: Ref }[];
  tools?: string[];
  /** ADR-0034: MCP servers whose (allowed) tools this agent may call in the tool loop. */
  toolServerRefs?: Ref[];
  /** Opt-in, human-curated read-only MCP tool names for direct conversations (ADR-0036). */
  chat?: { allowedTools: string[] };
  humanCounterpart?: { role: string };
  permissions?: { repositories?: string };
  /**
   * How a shared agent is called (e.g. `delegate` from other agents).
   * @preserveUnknownFields the input/output contract is documentation for delegating agents, not interpreted by the factory
   */
  invocation?: Record<string, unknown>;
}
export type Agent = DocumentResource<AgentSpec>;

/**
 * ADR-0034 (ADR-0011): an MCP server agents can use.
 * @validation rule="self.transport != 'http' || has(self.url)" message="http transport needs url"
 * @validation rule="self.transport != 'stdio' || has(self.command)" message="stdio transport needs command"
 */
export interface ToolServerSpec {
  transport: "http" | "stdio";
  /** `http`: Streamable HTTP endpoint. */
  url?: string;
  /** `stdio`: a local process — requires `hostExecution: true` (ADR-0080 §12). */
  command?: string;
  args?: string[];
  /** Sent as `Authorization: Bearer <secret>` (http) or as env `MCP_TOKEN` (stdio). Never stored (ADR-0015). */
  secretRef?: Ref;
  /** Only these tools are offered to agents. Empty or missing = none (explicit opt-in per tool). */
  allowedTools?: string[];
  /**
   * ADR-0080 §12: this definition starts a local process as the factory user (transport `stdio`). Default false.
   * Replaces "stdio is allowed only when `FACTORY_SANDBOX_RUNTIME=host`", and its use is recorded in the run's provenance.
   */
  hostExecution?: boolean;
  description?: string;
}
export type ToolServer = Resource<ToolServerSpec>;

export interface SkillSpec {
  description: string;
  requires?: Ref[];
}
export type Skill = DocumentResource<SkillSpec>;

export interface ArtifactTypeSpec {
  format: string;
  collection?: boolean;
  description?: string;
  schema?: { version: string; /** @preserveUnknownFields arbitrary JSON Schema */ jsonSchema: Record<string, unknown> };
}
export type ArtifactType = Resource<ArtifactTypeSpec>;

export interface StepSpec {
  name: string;
  agentRef: Ref;
  skillRefs?: Ref[];
  /** Narrows the agent's tools for this step (least privilege); `[]` = no tools. Can't add tools the agent lacks. */
  tools?: string[];
  /** Allowed outcomes (structured verdict), e.g. `[pass, partial, fail]` (ADR-0027). */
  outcomes?: string[];
  model?: { tier?: string };
  inputs?: { artifactRef: Ref }[];
  outputs?: { artifactRef: Ref }[];
}

/** @validation rule="(has(self.next) ? 1 : 0) + (has(self.block) ? 1 : 0) + (has(self.end) ? 1 : 0) == 1" message="exactly one of next, block, end must be set" */
export interface GateRoute {
  next?: string;
  block?: string;
  end?: string;
}

/** @validation rule="self.type != 'human-approval' || (has(self.approvers) && self.approvers.size() > 0)" message="a human-approval gate needs at least one approver" */
export interface GateSpec {
  type: string; // "decision" | "human-approval" | "automated" | extensible
  /** @maxProperties 32 */
  routes?: Record<string, GateRoute>;
  approvers?: { role: string }[];
  criteria?: string[];
  checks?: string[];
  onReject?: GateRoute;
  /** @preserveUnknownFields failure routing is interpreted by registered gate evaluators */
  onFailure?: Record<string, unknown>;
  publication?: { artifactRef: Ref; reviewStage: string };
}

export interface StageSpec {
  name: string;
  /** Phase the WorkItem shows while this stage runs. */
  sets?: { phase: string };
  mode?: string;
  /** Q1: if the stage's last outcome matches, go back to `goto` (bounded by `maxAttempts`) before the gate. */
  loop?: { when: { outcome: string }; goto: string; /** @minimum 1 */ maxAttempts: number };
  /** ADR-0023: on entering the stage, publish the item's workspaces (outbox). */
  publish?: {
    pullRequest?: {
      draft?: boolean;
      /** ADR-0053: a conflict with the current base goes back to `next` (bounded); without it, a human resolves. */
      onConflict?: { next: string; /** @minimum 1 */ maxAttempts?: number };
    };
    /** ADR-0084: create one tracker ticket from the draft the `reviewStage` human approval approved. */
    issue?: {
      artifactRef: Ref;
      reviewStage: string;
      /** Default target; `WorkItem.spec.ticketTarget` overrides it. */
      targetRef?: Ref;
    };
  };
  steps?: StepSpec[];
  gate?: GateSpec;
  workflowRef?: Ref;
  forEach?: { artifactRef: Ref; as: string; /** @minimum 1 */ parallelism?: number };
}

/** @validation rule="!has(self.unitExecution) || has(self.verification)" message="unitExecution requires verification" */
export interface WorkflowSpec {
  /** Opt-in technical recovery, independent of the approved verification budgets. */
  recovery?: import("./recovery.ts").RecoveryPolicy;
  /**
   * @validation rule="has(self.plannerStage) != (has(self.revisionStage) || has(self.synthesisStage))" message="set plannerStage, or revisionStage together with synthesisStage"
   * @validation rule="has(self.revisionStage) == has(self.synthesisStage)" message="revisionStage and synthesisStage go together"
   */
  planning?: { reviewStage: string; planFormat?: import("./planning.ts").PlanFormat } & (
    | { plannerStage: string; revisionStage?: never; synthesisStage?: never }
    | { plannerStage?: never; revisionStage: string; synthesisStage: string }
  );
  verification?: {
    planningStage: string;
    reviewStage: string;
    preflightStage: string;
    verifyStage: string;
    implementationStage: string;
    /** Named checks prepare the candidate on entry, before this stage's AI and human review. */
    preparationStage?: string;
    /** @minimum 1 */
    maxCodeAttempts: number;
    /** @minimum 1 */
    maxExecutionAttempts: number;
    /** @minimum 0 */
    retryDelayMs: number;
  };
  /**
   * ADR-0047: implement approved Units one at a time and require current readiness evidence for every Unit before
   * `barrierStage` (the first stage after implementation) starts any review. Requires `verification`.
   */
  unitExecution?: { barrierStage: string; /** @minimum 1 */ maxCodeAttempts: number; /** @minimum 1 */ maxExecutionAttempts: number };
  timebox?: string;
  trigger?: { sourceRefs?: Ref[]; output?: { artifactRef: Ref } };
  /**
   * @minItems 1
   * @maxItems 20
   */
  phases: {
    name: string;
    /** @maxItems 50 */
    stages: StageSpec[];
  }[];
  /** @preserveUnknownFields legacy, ignored by the workflow compiler */
  humanInput?: Record<string, unknown>;
  /** @preserveUnknownFields legacy, ignored by the workflow compiler */
  loop?: Record<string, unknown>;
}
export type Workflow = Resource<WorkflowSpec>;

/** @validation rule="!has(self.sync) || !has(self.sync.mode) || self.sync.mode != 'poll' || has(self.sync.pollInterval)" message="poll mode needs sync.pollInterval" */
export interface SourceSpec {
  type: string;
  /** @preserveUnknownFields connection settings differ per registered source connector */
  connection?: Record<string, unknown> & { secretRef?: Ref };
  sync?: {
    mode?: "webhook" | "poll";
    pollInterval?: string;
    /** @preserveUnknownFields filters differ per registered source connector */
    filter?: Record<string, unknown>;
    bidirectional?: boolean;
  };
  mapping?: Record<string, string>;
  defaults?: { workflowRef?: Ref; repositoryRefs?: Ref[] };
  /** Explicit human-reviewed actions, independent of automatic clarification synchronization. */
  writeBack?: { replyVisibilities?: ("public" | "internal")[]; transitions?: boolean;
    /** ADR-0066: permits creating issues here. The project key and defaults live in config, never in code. */
    issues?: { project?: string; issueType?: string; labels?: string[]; pickUpLabels?: string[];
      /** @preserveUnknownFields tracker-specific issue fields */
      fields?: Record<string, unknown>;
      /** ADR-0068: link a created follow-up ticket to its origin ticket (Jira, same instance). Off by default. */
      linkOrigin?: boolean } };
}
export type Source = Resource<SourceSpec>;

/** @validation rule="has(self.git) || has(self.local)" message="a repository needs a git remote or a local path" */
export interface RepositorySpec {
  git?: { url: string; defaultBranch?: string; secretRef?: Ref };
  local?: { path: string };
  index?: { enabled?: boolean; type?: string; refreshOn?: string[]; include?: string[]; exclude?: string[] };
  context?: { docs?: string[]; owners?: { role: string; team?: string }[] };
  /** @preserveUnknownFields settings differ per monitoring backend */
  observability?: Record<string, unknown>;
  /** Default sandbox for agents working on this repository. */
  sandboxRef?: Ref;
  /** ADR-0066: default Source where agent findings for this repository are proposed. */
  issueTrackerRef?: Ref;
  /**
   * ADR-0023: check name → command run in the workspace, e.g. `build: cd web && npx tsc --noEmit -p .`.
   * `scoped` (ADR-0061): the command takes a module selection whose scope follows the verification tier.
   * `moduleScoped` (legacy, ADR-0044): always the affected scope, whatever the tier.
   * @preserveUnknownValues a check is either a command string or an object, which a structural schema cannot express
   * `rerunFailed` (ADR-0086): runs only named failed tests, given as `$FACTORY_RERUN_PATTERN` and `$FACTORY_RERUN_FILES`.
   */
  checks?: Record<string, string | { command: string; timeoutMs?: number; maxOutputBytes?: number; resultFormat?: string; scoped?: boolean; moduleScoped?: boolean; rerunFailed?: string }>;
  /** Repository-maintained dependency graph: module name → {path, depends_on}. Shared paths are repository-relative globs. */
  moduleScope?: { graph: string; sharedPaths: string[]; nonBuildPaths?: string[] };
  verification?: { requiredChecks: string[]; preflightChecks: string[]; preparationChecks?: string[]; waivableChecks?: string[];
    /** ADR-0067: Git-declared policy waivers; each check must also be in `waivableChecks`. Verify stage only. */
    autoWaive?: AutoWaive[];
    /** ADR-0047: configured checks an approved Unit manifest may require as construction-readiness evidence. */
    readinessChecks?: string[];
    /** ADR-0061: raises a scoped check's scope in a tier above the tier's default, e.g. `{ verification: { tests: "full" } }`. */
    minScope?: Partial<Record<VerificationTier, Record<string, "affected" | "full">>> };
  /** Workspace preparation (ADR-0021): commands run once in a fresh workspace, e.g. `cd web && npm ci`. */
  workspace?: { baseRef?: string; setup?: string[] };
}
export type Repository = Resource<RepositorySpec>;

/** ADR-0023: only repositories with a `git` remote are ever pushed or get pull requests. */
export const isPublishable = (repository: Repository) => !!repository.spec.git?.url;

export interface ModelProviderSpec {
  type: string; // "openai-compatible" | "anthropic" | …
  baseUrl?: string;
  secretRef?: Ref;
  /** @minProperties 1 */
  models: Record<string, string>; // tier → model
  /** Optional agent name → model, overrides the tier mapping for that agent (ADR-0028). */
  agentModels?: Record<string, string>;
  default?: boolean;
}
export type ModelProvider = Resource<ModelProviderSpec>;

/** Runtime-neutral sandbox definition; adapters translate it (ADR-0019). */
export interface SandboxProfileSpec {
  image: string;
  resources?: { cpu?: string; memory?: string; /** @minimum 1 */ pids?: number; timeout?: string };
  /** @validation rule="self.mode == 'allowlist' || !has(self.allow) || self.allow.size() == 0" message="allow is only valid with mode allowlist" */
  network?: { mode: "none" | "allowlist"; allow?: string[] };
  filesystem?: { workspace?: string; rootReadOnly?: boolean; tmpfs?: string[] };
  user?: string;
  /**
   * Plain environment variables for every command in the sandbox, e.g. `GOPROXY` (ADR-0033). Definitions are in Git:
   * never put secrets here (rule 16); commands otherwise only get PATH, HOME, LANG, TERM, USER.
   */
  env?: Record<string, string>;
  /**
   * ADR-0088: binaries the sandbox must provide, and how to obtain each one. The factory installs them into its own
   * persistent toolchain cache (on `PATH`), so a repository never scripts `PATH`/install plumbing into its checks.
   */
  tools?: ToolSpec[];
  /** Minimum isolation; runtimes below it are never used. */
  isolation?: "process" | "container" | "microvm";
  /**
   * ADR-0080 §11: if the selected runtime cannot provide `spec.isolation`, it may be used at the strongest level it does
   * provide (recorded as effective-versus-declared isolation). Default false: a runtime below the minimum is refused.
   * Replaces the implicit `FACTORY_SANDBOX_RUNTIME=bwrap` waiver.
   */
  acceptWeakerIsolation?: boolean;
}
export type SandboxProfile = Resource<SandboxProfileSpec>;

/**
 * ADR-0088: a binary the sandbox must provide. `provides` is where readiness is observed — a path relative to the
 * factory-owned toolchain cache — so the factory can answer "is this tool ready?" without running anything. `via` names
 * exactly one registered provisioner type (rule 4) and its parameters as data; `command` is the documented escape hatch
 * for a tool no provisioner knows yet.
 */
export interface ToolSpec {
  name: string;
  provides: string;
  via: { type: string; with?: Record<string, string> };
}

// ── Runtime ──────────────────────────────────────────────────────────────

export type WorkItemPhase =
  | "New"
  | "Running"
  /** The current agent run can't proceed yet (model quota / rate limit, or no LLM/sandbox with FACTORY_SIMULATION=wait). */
  | "Waiting"
  | "Blocked"
  | "AwaitingApproval"
  | "Done"
  | "Closed"
  | "Failed";

export interface Classification {
  type?: string;
  priority?: string;
  labels?: string[];
  confidence?: number;
}

/** One comment of the source ticket's conversation (ADR-0070). */
export interface SourceComment {
  id: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  /** `internal`: only the service-desk team sees it (also restricted comments). Never reveal it to the requester. */
  visibility: "public" | "internal";
  body: string;
  /** Posted by the factory itself (echo marker). */
  byFactory?: boolean;
}

/** One field change of the source ticket (status, assignee, priority, …). */
export interface SourceChange {
  at: string;
  author: string;
  field: string;
  from?: string;
  to?: string;
}

/**
 * The source ticket's conversation and change history, written by sync like title and description (ADR-0070).
 * Mandatory for sources whose connector can read it: an item is never imported or updated without it.
 */
export interface SourceHistory {
  fetchedAt: string;
  comments: SourceComment[];
  changes: SourceChange[];
  /** Entries beyond the connector's bound (oldest dropped). */
  omitted?: { comments?: number; changes?: number };
}

export interface WorkItemSpec {
  title: string;
  description?: string;
  /**
   * Extra context from the team (Markdown), e.g. environment, customer setup, what was already tried. Written by
   * humans only; sync never touches it. Every agent sees it (ADR-0032).
   */
  context?: string;
  /** Comments and change history of the source ticket; sync-only, humans never edit it (ADR-0070). */
  sourceHistory?: SourceHistory;
  sourceRef: Ref;
  externalRef?: { id: string; url?: string };
  workflowRef?: Ref;
  repositoryRefs?: Ref[];
  /** ADR-0084: Source a `publish.issue` block creates the ticket in (human-written; default from the block). */
  ticketTarget?: Ref;
  /** Human-created handoff from a direct agent conversation (ADR-0036). */
  conversationRef?: Ref;
  /** Historical provenance, validated at creation; not a live dependency or cascade owner. */
  originWorkItemRef?: Ref;
  originSnapshot?: {
    uid: string;
    resourceVersion: string;
    capturedAt: string;
    versions: Record<string, string>;
    content: string;
    truncated: boolean;
  };
  /** Human request to re-run the workflow from `stage` (default: first stage). A new `id` triggers it once. */
  restart?: {
    id: string;
    stage?: string;
    requestedBy?: string;
    /** Also supersede stages in the previous workflow when a human explicitly changes workflows. */
    supersedeFrom?: { workflow: string; stage: string };
  };
  /** Explicit human hold; never implicitly lifted by restarting or approving a gate. */
  publicationDisabled?: boolean;
  planning?: {
    revision: string;
    discovery: string;
    batchSubmitted?: boolean;
    answers: Record<string, { signature: string; question: string; answer: string; answeredAt?: string; answeredBy?: string }>;
    withdrawn?: { decisionId: string; question: string; answer: string; withdrawnBy: string; at: string }[];
    draft?: import("./planning.ts").PlanningSections;
    feedback?: string;
    disposition?: "rejected" | "deferred";
    request: { id: string; fingerprint: string; by: string };
  };
  retrospective?: RetrospectiveSnapshot;
  retrospectiveOutcome?: {
    disposition: "open" | "deferred" | "closed";
    by: string;
    at: string;
    implementation?: string;
    loadedVersion?: string;
    benefit?: string;
  };
}

/** On artifacts that a restart replaced: kept for history, never used as agent input again. */
export const LABEL_SUPERSEDED = "factory.ai-dlc.io/superseded";

export interface WorkItemStatus {
  recovery?: import("./recovery.ts").RecoveryEpisode[];
  staleRecoveryAllowances?: string[];
  phase: WorkItemPhase;
  /** AI-DLC phase of the current stage (inception / construction / operations). */
  lifecyclePhase?: string;
  stage?: string;
  step?: number;
  /** Monotonic counter, incremented on every stage (re-)entry. Part of idempotency keys. */
  round?: number;
  classification?: Classification;
  lastOutcome?: string;
  blockedBy?: { kind: "Clarification" | "Approval"; name: string };
  /** Retry budget used per stage: failed checks (ADR-0023) and review→fix loops (Q1). */
  retries?: Record<string, number>;
  /** `<stage>@r<round>` once a stage loop's budget is used up (LoopExhausted is recorded exactly once). */
  loopExhausted?: string;
  /** `spec.restart.id` of the last restart that was carried out. */
  restartHandled?: string;
  message?: string;
  conditions?: Condition[];
}
export type WorkItem = Resource<WorkItemSpec, WorkItemStatus>;

export type RunPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface AgentRunSpec {
  recovery?: import("./recovery.ts").RecoveryAssignment;
  workItemRef: Ref;
  agentRef: Ref;
  skillRefs: Ref[];
  stage: string;
  step: string;
  inputs: Ref[];   // ArtifactType names
  outputs: Ref[];  // ArtifactType names
  modelTier?: string;
  /** Allowed decision outcomes when the stage ends in a decision gate. */
  outcomes?: string[];
  /** Step-level tool narrowing, copied from the workflow step. */
  tools?: string[];
  /** Set when this run was delegated by another run. */
  parentRunRef?: Ref;
  /** Set when this run re-runs another one (ADR-0012 replay). Replays never advance the workflow. */
  replayOf?: Ref;
  question?: string;
  /** Compiler provenance at scheduling time, never reconstructed from today's definitions. */
  workflow?: { versions: Record<string, string>; target: { namespace: string; name: string; version: string }; stage: string };
  /** ADR-0047: the approved Unit (or cross-Unit repair) this implementation attempt is responsible for. */
  assignment?: UnitAssignment;
}

/** ADR-0047: `CheckWorkflowOrigin.unit` of aggregate pre-review barrier jobs. */
export const BARRIER_UNIT = "*";

export type UnitAssignment =
  | { kind: "unit"; planFingerprint: string; unit: string }
  | { kind: "repair"; planFingerprint: string };

export interface AgentRunStatus {
  phase: RunPhase;
  executor?: string;
  startedAt?: string;
  finishedAt?: string;
  outputs?: Ref[];   // Artifact names
  result?: AgentResultSummary;
  message?: string;
  /** ADR-0012: append-only transcript of this run. */
  transcriptRef?: { namespace: string; id: string };
  provenance?: RunProvenance;
  /** Model temporarily unavailable (quota, rate limit): the run waits until then instead of failing. */
  retryAt?: string;
  /** Consecutive waits for the model (drives the backoff). */
  modelWaits?: number;
  feedbackCandidates?: RetrospectiveFeedbackSpec[];
  feedbackWarnings?: string[];
  /** ADR-0047: an assigned attempt found Running after a factory restart; it is never re-executed blindly. */
  interrupted?: boolean;
}
export type AgentRun = Resource<AgentRunSpec, AgentRunStatus>;

export interface RetrospectivePolicy {
  version: string;
  issueCodes: string[];
  minimumOrigins: number;
  minimumRoles: number;
  windowDays: number;
}

export interface RetrospectiveObservation {
  stage: string;
  issueCode: string;
  stance: "support" | "positive" | "counterevidence";
  observation: string;
  impact: string;
  suggestion: string;
  evidence: string;
}

export interface RetrospectiveFeedbackSpec {
  observation: RetrospectiveObservation;
  target: { namespace: string; name: string; version: string; stage: string; workflowVersions: Record<string, string> };
  reporter: { agent: string; role: string; kind: "agent" | "controller" };
  origin: { workItem: string; workItemUid: string; agentRun: string; agentRunUid: string };
  capturedAt: string;
  executor: string;
  verified: boolean;
  replay: boolean;
  superseded: boolean;
  truncated: boolean;
  review?: { disposition: "open" | "dismissed"; issueCode?: string; comment: string; by: string; at: string };
  investigationRequest?: { id: string; by: string; at: string; revision: string };
}

export interface RetrospectiveFeedbackStatus {
  phase: "Observed" | "Eligible" | "Investigating";
  exclusions: string[];
  conditions?: Condition[];
  investigations?: { name: string; uid: string; cycle: string }[];
}
export type RetrospectiveFeedback = Resource<RetrospectiveFeedbackSpec, RetrospectiveFeedbackStatus>;

export interface RetrospectiveSnapshot {
  group: string;
  cycle: string;
  capturedAt: string;
  policy: RetrospectivePolicy;
  revision: string;
  origins: number;
  roles: string[];
  truncated: boolean;
  reports: { name: string; uid: string; fingerprint: string; eligible: boolean; exclusions: string[]; spec: RetrospectiveFeedbackSpec }[];
}

/** ADR-0067: a comparable finding (e.g. an npm advisory) reported by a registered classifier. */
export interface CheckFinding { id: string; severity?: string; title?: string }
/** `flaky` (ADR-0086): every failure of the check passed in another attempt or targeted re-run on the same snapshot. */
export interface AutoWaive { check: string; when: "pre-existing" | "flaky"; followUp?: "finding" }
export type CheckOutcome = "Passed" | "FindingsReported" | "AssertionFailed" | "SetupFailed" | "UnknownFailure" | "Unavailable" | "TimedOut" | "Cancelled" | "NotVerified";

export interface CheckWorkflowOrigin {
  stage: string;
  round: number;
  /** `rerun-failed` (ADR-0086): only the failed tests of `rerunOf` again; evidence for flakiness, never a pass of the check. */
  purpose: "preflight" | "preparation" | "verification" | "unit-readiness" | "diagnostic" | "baseline" | "rerun-failed";
  planFingerprint: string;
  attempt: number;
  /** ADR-0047 (`unit-readiness` only): Unit ID, or `*` for the aggregate pre-review barrier. */
  unit?: string;
  /** ADR-0047: the implementation AgentRun whose result this readiness job checks (absent for the barrier). */
  unitRun?: string;
  /** Only this recorded caller may still be active while its requested check starts. */
  agentRunRef?: Ref;
  agentRequestId?: string;
  agentRunUid?: string;
  /** Diagnostic evidence is scoped to an episode and never counts as readiness or verification. */
  recoveryEpisode?: string;
  baselineCommit?: string;
  /** ADR-0086 (`rerun-failed` only): the CheckRun whose failed tests run again, on the same snapshot. */
  rerunOf?: string;
}

/** ADR-0061: when a check runs decides how much a scoped check covers. */
export type VerificationTier = "readiness" | "preparation" | "verification";
/** `changed`: modules changed against the pinned base; `affected`: plus transitive dependents (ADR-0044); `full`: all. */
export type ModuleScopeMode = "changed" | "affected" | "full";

export interface ModuleCheckScope {
  mode: ModuleScopeMode;
  baseCommit: string;
  graphHash: string;
  modules: string[];
  reason: string;
}

/**
 * ADR-0086: what a test check reported per test. A test's identity is its name path (`suite › test`): Node's TAP
 * output names the file only for failures. `touched`: the candidate changed or added the failed test's file.
 */
export interface CheckTestResults {
  failed: { name: string; file?: string; touched?: boolean }[];
  /** Test ids (`testId(name)`) of passed tests, sorted. */
  passed: string[];
  skipped: number;
}

export interface CheckRunSpec {
  workItemRef: Ref;
  workItemUid: string;
  workspaceRef: Ref;
  workspaceUid: string;
  repositoryRef: Ref;
  repositoryVersion: string;
  check: string;
  command: string;
  timeoutMs: number;
  snapshot: string;
  environment: { runtime: string; version?: string; profileVersion: string; isolation?: "none" | "process" | "container" | "microvm"; declaredIsolation?: "process" | "container" | "microvm" };
  requestedBy: string;
  requestFingerprint: string;
  resultFormat?: string;
  scope?: ModuleCheckScope;
  workflow?: CheckWorkflowOrigin;
}

export interface CheckRunStatus {
  conditions?: Condition[];
  phase: "Running" | "Completed" | "Interrupted";
  startedAt?: string;
  finishedAt?: string;
  outcome?: CheckOutcome;
  /** Command classification before candidate/origin freshness invalidates authoritative evidence. */
  executionOutcome?: CheckOutcome;
  failureEvidence?: { tests: string[] };
  /** ADR-0067: findings extracted by a FindingExtractor; only set with complete output. */
  findings?: CheckFinding[];
  /** ADR-0086: per-test results of a test check; only set with complete, unchanged-snapshot output. */
  tests?: CheckTestResults;
  /** ADR-0086: the redacted end of the output of a run that did not pass, so a question can show the evidence. */
  outputTail?: string;
  message?: string;
  exitCode?: number;
  signal?: string;
  durationMs?: number;
  logRef?: { namespace: string; id: string };
  logsIncomplete?: boolean;
  finalSnapshot?: string;
}
export type CheckRun = Resource<CheckRunSpec, CheckRunStatus>;

/** Everything needed to explain or re-run a run (ADR-0012). */
export interface RunProvenance {
  executor: string;
  model?: { provider?: string; name?: string; tier?: string; params?: Record<string, unknown> };
  /** Definition versions used: kind/name → resourceVersion or git commit. */
  definitions: Record<string, string>;
  /** Input artifact name → resourceVersion. */
  inputs: Record<string, string>;
  contexts?: Record<string, string>;
  clarifications?: string[];
  /** Submitted InlineFeedback names this run received (ADR-0071); each note reaches one run of its step only. */
  feedback?: string[];
  promptHash?: string;
  /** Set when this run is a re-run of another. */
  replayOf?: Ref;
  /** Sandbox runtime used or attempted, e.g. "none", "podman@5.5" (ADR-0019). */
  executionEnvironment?: string;
  /**
   * ADR-0080 §11 / P0-7: the isolation the run actually got, next to the profile's declared minimum, so a reviewer can
   * see a weaker-than-declared runtime in gate evidence.
   */
  isolation?: { effective: "none" | "process" | "container" | "microvm"; declared: "process" | "container" | "microvm"; acceptedWeaker: boolean };
  /** ADR-0080 §12: ToolServers that ran a local process as the factory user (`spec.hostExecution`) in this run. */
  hostExecution?: string[];
  /** ADR-0080 §2/§3/§13: the `AgentRuntime` backend that ran this run, its pinned image and the ingested export. */
  runtime?: { backend: string; image?: string; exportedCommit?: string; protocol?: number };
  /** Code state the agent saw: repository → commit (ADR-0021). */
  workspaces?: Record<string, string>;
  /** ADR-0057: how the agent used its tools. Observability only, never gate criteria. */
  toolUse?: { steps: number; calls: Record<string, number>; finishCorrections: number; wrapUp?: boolean };
  /** ADR-0057: counts reported by context providers, by source (e.g. cited-code resolved/unresolved). */
  contextCounts?: Record<string, Record<string, number>>;
}

/** ADR-0030: where a knowledge entry or source applies. Empty = everywhere. */
export interface KnowledgeScope {
  repositoryRefs?: Ref[];
  workflowRefs?: Ref[];
}

export interface KnowledgeEntrySpec {
  title: string;
  /** Markdown. */
  content: string;
  tags?: string[];
  /** Plain names, not refs (like provenance): an entry must stay editable even if a definition is renamed later. */
  scope?: { repositories?: string[]; workflows?: string[] };
  /** Plain names, not refs: entries outlive the runs and items they came from. */
  provenance?: { agent?: string; agentRun?: string; workItem?: string; proposedAt?: string; proposedBy?: string };
  /** Human decision (rule 8). Only approved entries are shown to agents. */
  review?: { decision: "approve" | "reject"; by?: string; at?: string; comment?: string };
  retired?: boolean;
}
export type KnowledgePhase = "Proposed" | "Approved" | "Rejected" | "Retired";
export interface KnowledgeEntryStatus {
  phase: KnowledgePhase;
  approvedAt?: string;
}
export type KnowledgeEntry = Resource<KnowledgeEntrySpec, KnowledgeEntryStatus>;

/** ADR-0030: external docs (runbooks, product docs). `type` selects the registered search (`files` = ripgrep). */
/** @validation rule="self.type != 'files' || has(self.local)" message="a files knowledge source needs local.path" */
export interface KnowledgeSourceSpec {
  type: string;
  description?: string;
  local?: { path: string };
  include?: string[];
  exclude?: string[];
  scope?: KnowledgeScope;
}
export type KnowledgeSource = Resource<KnowledgeSourceSpec>;

export interface ConversationSpec {
  /** Item being explained or supplied as evidence to `agent-chat` (ADR-0037). */
  workItemRef?: Ref;
  /** Set for `explain` (one run); absent for `explain-item` (the whole work item, X4). */
  agentRunRef?: Ref;
  agentRef?: Ref;
  /** Set for `refine-knowledge` (ADR-0030). */
  knowledgeRef?: Ref;
  /** Selects the registered responder or durable turn runner. `draft-ticket` records follow-up ticket drafts (ADR-0076). */
  purpose: "explain" | "explain-item" | "refine-knowledge" | "agent-chat" | "draft-ticket";
  title?: string;
  turn?: { id: string; text: string; submittedBy: string };
  startedBy?: string;
}
export interface ConversationStatus {
  transcriptRef?: { namespace: string; id: string };
  messageCount?: number;
  lastMessageAt?: string;
  phase?: "Queued" | "Running" | "Waiting" | "Ready" | "Failed";
  activeTurn?: string;
  completedTurn?: string;
  message?: string;
  retryAt?: string;
  modelWaits?: number;
}
export type Conversation = Resource<ConversationSpec, ConversationStatus>;

export interface AgentResultSummary {
  summary?: string;
  outcome?: string;
  classification?: Classification;
  questions?: (string | { id?: string; text: string; blocker?: boolean; options?: string[] })[];
}

export interface ArtifactSpec {
  artifactTypeRef: Ref;
  workItemRef: Ref;
  producedBy?: { agentRunRef: Ref; agentRef: Ref };
  format: string;
  content: string;
}
export type Artifact = Resource<ArtifactSpec>;

/**
 * ADR-0071: a human's inline note on a passage of an artifact. Drafts collect until the human submits them as one
 * batch; the next run of the producing step then receives them (once, recorded in its provenance). Humans write the
 * spec; the state (draft / submitted / addressed) is derived from `submitted` and run provenance, so there's no status.
 */
export interface InlineFeedbackSpec {
  workItemRef: Ref;
  /** The Artifact (exact version) the human read and annotated. */
  targetRef: Ref;
  /** Producer of the target: the next run of this stage/step receives the feedback. */
  producedBy: { agentRunRef: Ref; agentRef: Ref; stage: string; step: string };
  /** The selected passage, as plain text. */
  quote: string;
  comment: string;
  author?: string;
  /** Set when the human submits the batch; drafts have none. */
  submitted?: { id: string; at: string; by: string };
}
export type InlineFeedback = Resource<InlineFeedbackSpec>;

export interface ClarificationSpec {
  workItemRef: Ref;
  stage: string;
  questions: string[];
  /** Answer options per question (parallel to questions; empty = free-form). */
  options?: string[][];
  /** Who stopped the item: the agent run that asked, or the gate that needs a human decision. */
  askedBy?: { agentRunRef?: Ref; gate?: string };
  /** Supporting Markdown shown beside the questions (not part of them). */
  details?: string;
  assignee?: string;
  /** Written by a human (UI or synced from the source). */
  answers?: string[];
  answeredBy?: string;
}
export interface ClarificationStatus {
  phase: "Open" | "Answered";
  answeredAt?: string;
}
export type Clarification = Resource<ClarificationSpec, ClarificationStatus>;

export interface TicketTransition {
  id: string;
  name: string;
  to: { id: string; name: string };
  requiresFields: boolean;
}

export interface TicketPublication {
  workItemUid: string;
  source: string;
  sourceVersion: string;
  externalId: string;
  artifact: { name: string; uid: string; version: string };
  body: string;
  reviewed?: {
    revision: string;
    visibility: "public" | "internal";
    fromStatusId: string;
    transition?: TicketTransition;
    by: string;
  };
}

export interface ApprovalSpec {
  recoveryAllowance?: import("./recovery.ts").RecoveryAllowance;
  workItemRef: Ref;
  stage: string;
  approvers: { role: string }[];
  criteria?: string[];
  /** Written by a human. */
  decision?: "approve" | "reject";
  decidedBy?: string;
  comment?: string;
  /** Approved despite blocking evidence (ADR-0027); the comment holds the reason. */
  overridden?: boolean;
  ticketPublication?: TicketPublication;
  retrospective?: { fingerprint: string };
  verification?: {
    kind: "plan" | "candidate" | "waiver";
    fingerprint: string;
    planFingerprint: string;
    requirements?: string[];
    /** ADR-0054: plan re-confirmation; the earlier human-approved plan binding this approval carries forward. */
    rebinds?: string;
    /** ADR-0054: digest of the reviewed specification and validation plan, without workflow/repository definitions. */
    content?: string;
  };
}
export interface ApprovalStatus {
  phase: "Pending" | "Approved" | "Rejected";
}
export type Approval = Resource<ApprovalSpec, ApprovalStatus>;

export interface EventSpec {
  involvedObject: { kind: string; name: string; uid?: string };
  type: "Normal" | "Warning";
  reason: string;
  message: string;
}
export type FactoryEvent = Resource<EventSpec>;

export interface OutboxMessageSpec {
  /** Set for effects on a source item (comments); absent e.g. for pull requests (ADR-0023). */
  sourceRef?: Ref;
  externalId?: string;
  action: string; // e.g. "comment"
  payload: Record<string, unknown>;
}
export interface OutboxMessageStatus {
  phase: "Pending" | "Delivering" | "Delivered" | "Failed";
  /** Handler result, e.g. `{ url }` of an opened pull request. */
  result?: Record<string, unknown>;
  attempts?: number;
  lastError?: string;
  nextAttemptAt?: string;
}
export type OutboxMessage = Resource<OutboxMessageSpec, OutboxMessageStatus>;

// ── Workspace (ADR-0021) ─────────────────────────────────────────────────

export interface WorkspaceSpec {
  workItemRef: Ref;
  repositoryRef: Ref;
  /** Git ref to fork from; default: the repository checkout's HEAD. */
  baseRef?: string;
  branch: string;
  setup?: string[];
  /** ADR-0053: merge this base commit into the workspace (requested by the WorkItem controller on a conflict). */
  /** `round`: the WorkItem round that asked; a new round retries a failed merge of the same commit. */
  integrate?: { commit: string; ref: string; round: number };
}

export interface WorkspaceStatus {
  phase: "Pending" | "Preparing" | "Ready" | "Failed";
  path?: string;
  baseCommit?: string;
  headCommit?: string;
  preparedBy?: string;
  message?: string;
  /** Output of the setup commands (truncated). */
  setupLog?: string;
  setupCompleted?: boolean;
  /** ADR-0053: result of the last `spec.integrate`; `baseCommit` is re-pinned to the merged base. */
  integration?: { commit: string; ref: string; round: number; conflicts: string[]; error?: string; at: string };
}
export type Workspace = Resource<WorkspaceSpec, WorkspaceStatus>;

/** ADR-0066: an issue the factory may create in a tracker once a human approves it. */
/** `story`: published by a workflow's `publish.issue` block after a human approved the draft (ADR-0084). */
export type IssuePurpose = "mirror" | "finding" | "escalation" | "unit" | "follow-up" | "story";
export type IssuePhase = "Proposed" | "Approved" | "Creating" | "Created" | "Uncertain" | "Failed" | "Rejected";
export interface IssueProposalSpec {
  purpose: IssuePurpose;
  targetRef?: Ref;
  title: string;
  /** Markdown. */
  body: string;
  issueType?: string;
  labels?: string[];
  pickUp?: boolean;
  /** ADR-0068: ADR-0039 preview revision a follow-up ticket was created from. */
  revision?: string;
  relatesTo?: string[];
  parent?: string;
  provenance?: {
    agent?: string; agentRun?: string; workItem?: string; proposedAt?: string; proposedBy?: string; human?: boolean;
    /** ADR-0076: the agent that drafted the body the human approved, and its `draft-ticket` conversation. */
    draftedBy?: { agent: string; conversation: string };
    /** ADR-0084: the gate approval and the exact artifact version a `story` ticket was published from. */
    approval?: string;
    artifact?: { name: string; uid: string; resourceVersion: string };
  };
  review?: { decision: "approve" | "reject"; contentHash?: string; by?: string; at?: string; comment?: string };
  resolution?: { action: "create-again" | "link"; externalId?: string; by?: string; at?: string };
}
export interface IssueProposalStatus {
  phase: IssuePhase;
  approved?: { contentHash: string; at: string; by?: string };
  attempt?: number;
  externalRef?: { externalId: string; url?: string };
  /** Delayed lookups after an unknown outcome (ADR-0066 §4): when the failure was first seen and how many lookups ran. */
  lookup?: { since: string; count: number };
  /** Key of the last human resolution applied, so it is consumed once. */
  resolved?: string;
  /** ADR-0068: read-only tracker state, written by the controller only. */
  tracked?: { state?: string; open?: boolean; assignee?: string; updatedAt?: string; readAt: string };
  conditions?: { type: string; status: "True" | "False" | "Unknown"; reason?: string; message?: string }[];
}
export type IssueProposal = Resource<IssueProposalSpec, IssueProposalStatus>;
