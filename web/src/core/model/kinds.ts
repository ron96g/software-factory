/**
 * Typed spec/status shapes per kind.
 * Definitions mirror the YAML/Markdown in the repo. Runtime kinds live in the store.
 */
import type { Condition, DocumentResource, Ref, Resource } from "./resource.ts";

// ── Definitions ──────────────────────────────────────────────────────────

export interface AgentSpec {
  role: string;
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
}
export type Agent = DocumentResource<AgentSpec>;

/** ADR-0034 (ADR-0011): an MCP server agents can use. */
export interface ToolServerSpec {
  transport: "http" | "stdio";
  /** `http`: Streamable HTTP endpoint. */
  url?: string;
  /** `stdio`: local process (host runtime opt-in only, ADR-0020). */
  command?: string;
  args?: string[];
  /** Sent as `Authorization: Bearer <secret>` (http) or as env `MCP_TOKEN` (stdio). Never stored (ADR-0015). */
  secretRef?: Ref;
  /** Only these tools are offered to agents. Empty or missing = none (explicit opt-in per tool). */
  allowedTools?: string[];
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

export interface GateRoute {
  next?: string;
  block?: string;
  end?: string;
}

export interface GateSpec {
  type: string; // "decision" | "human-approval" | "automated" | extensible
  routes?: Record<string, GateRoute>;
  approvers?: { role: string }[];
  criteria?: string[];
  checks?: string[];
  onReject?: GateRoute;
  onFailure?: Record<string, unknown>;
  publication?: { artifactRef: Ref; reviewStage: string };
}

export interface StageSpec {
  name: string;
  mode?: string;
  /** Q1: if the stage's last outcome matches, go back to `goto` (bounded by `maxAttempts`) before the gate. */
  loop?: { when: { outcome: string }; goto: string; maxAttempts: number };
  /** ADR-0023: on entering the stage, publish the item's workspaces (outbox). */
  publish?: { pullRequest?: { draft?: boolean } };
  steps?: StepSpec[];
  gate?: GateSpec;
  workflowRef?: Ref;
  forEach?: { artifactRef: Ref; as: string; parallelism?: number };
}

export interface WorkflowSpec {
  verification?: {
    planningStage: string;
    reviewStage: string;
    preflightStage: string;
    verifyStage: string;
    implementationStage: string;
    /** Named checks prepare the candidate on entry, before this stage's AI and human review. */
    preparationStage?: string;
    maxCodeAttempts: number;
    maxExecutionAttempts: number;
    retryDelayMs: number;
  };
  timebox?: string;
  trigger?: { sourceRefs?: Ref[] };
  phases: { name: string; stages: StageSpec[] }[];
  humanInput?: Record<string, unknown>;
  loop?: Record<string, unknown>;
}
export type Workflow = Resource<WorkflowSpec>;

export interface SourceSpec {
  type: string;
  connection?: Record<string, unknown> & { secretRef?: Ref };
  sync?: {
    mode?: "webhook" | "poll";
    pollInterval?: string;
    filter?: Record<string, unknown>;
    bidirectional?: boolean;
  };
  mapping?: Record<string, string>;
  defaults?: { workflowRef?: Ref; repositoryRefs?: Ref[] };
  /** Explicit human-reviewed actions, independent of automatic clarification synchronization. */
  writeBack?: { replyVisibilities?: ("public" | "internal")[]; transitions?: boolean };
}
export type Source = Resource<SourceSpec>;

export interface RepositorySpec {
  git?: { url: string; defaultBranch?: string; secretRef?: Ref };
  local?: { path: string };
  index?: { enabled?: boolean; type?: string; include?: string[]; exclude?: string[] };
  context?: { docs?: string[]; owners?: { role: string; team?: string }[] };
  observability?: Record<string, unknown>;
  /** Default sandbox for agents working on this repository. */
  sandboxRef?: Ref;
  /** ADR-0023: check name → command run in the workspace, e.g. `build: cd web && npx tsc --noEmit -p .`. */
  checks?: Record<string, string | { command: string; timeoutMs?: number; resultFormat?: string; moduleScoped?: boolean }>;
  /** Repository-maintained dependency graph: module name → {path, depends_on}. Shared paths are repository-relative globs. */
  moduleScope?: { graph: string; sharedPaths: string[]; nonBuildPaths?: string[] };
  verification?: { requiredChecks: string[]; preflightChecks: string[]; preparationChecks?: string[]; waivableChecks?: string[] };
  /** Workspace preparation (ADR-0021): commands run once in a fresh workspace, e.g. `cd web && npm ci`. */
  workspace?: { baseRef?: string; setup?: string[] };
}
export type Repository = Resource<RepositorySpec>;

export interface ModelProviderSpec {
  type: string; // "openai-compatible" | "anthropic" | …
  baseUrl?: string;
  secretRef?: Ref;
  models: Record<string, string>; // tier → model
  /** Optional agent name → model, overrides the tier mapping for that agent (ADR-0028). */
  agentModels?: Record<string, string>;
  default?: boolean;
}
export type ModelProvider = Resource<ModelProviderSpec>;

/** Runtime-neutral sandbox definition; adapters translate it (ADR-0019). */
export interface SandboxProfileSpec {
  image: string;
  resources?: { cpu?: string; memory?: string; pids?: number; timeout?: string };
  network?: { mode: "none" | "allowlist"; allow?: string[] };
  filesystem?: { workspace?: string; rootReadOnly?: boolean; tmpfs?: string[] };
  user?: string;
  /**
   * Plain environment variables for every command in the sandbox, e.g. `GOPROXY` (ADR-0033). Definitions are in Git:
   * never put secrets here (rule 16); commands otherwise only get PATH, HOME, LANG, TERM, USER.
   */
  env?: Record<string, string>;
  /** Minimum isolation; runtimes below it are never used. */
  isolation?: "process" | "container" | "microvm";
}
export type SandboxProfile = Resource<SandboxProfileSpec>;

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

export interface WorkItemSpec {
  title: string;
  description?: string;
  /**
   * Extra context from the team (Markdown), e.g. environment, customer setup, what was already tried. Written by
   * humans only; sync never touches it. Every agent sees it (ADR-0032).
   */
  context?: string;
  sourceRef: Ref;
  externalRef?: { id: string; url?: string };
  workflowRef?: Ref;
  repositoryRefs?: Ref[];
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
  restart?: { id: string; stage?: string; requestedBy?: string };
  /** Explicit human hold; never implicitly lifted by restarting or approving a gate. */
  publicationDisabled?: boolean;
}

/** On artifacts that a restart replaced: kept for history, never used as agent input again. */
export const LABEL_SUPERSEDED = "factory.ai-dlc.io/superseded";

export interface WorkItemStatus {
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
}

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
}
export type AgentRun = Resource<AgentRunSpec, AgentRunStatus>;

export type CheckOutcome = "Passed" | "AssertionFailed" | "SetupFailed" | "UnknownFailure" | "Unavailable" | "TimedOut" | "Cancelled" | "NotVerified";

export interface CheckWorkflowOrigin {
  stage: string;
  round: number;
  purpose: "preflight" | "preparation" | "verification";
  planFingerprint: string;
  attempt: number;
  /** Only this recorded caller may still be active while its requested check starts. */
  agentRunRef?: Ref;
  agentRequestId?: string;
  agentRunUid?: string;
}

export interface ModuleCheckScope {
  mode: "affected" | "full";
  baseCommit: string;
  graphHash: string;
  modules: string[];
  reason: string;
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
  environment: { runtime: string; version?: string; profileVersion: string };
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
  clarifications?: string[];
  promptHash?: string;
  /** Set when this run is a re-run of another. */
  replayOf?: Ref;
  /** Sandbox runtime used or attempted, e.g. "none", "podman@5.5" (ADR-0019). */
  executionEnvironment?: string;
  /** Code state the agent saw: repository → commit (ADR-0021). */
  workspaces?: Record<string, string>;
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
  /** Selects the registered responder or durable turn runner. */
  purpose: "explain" | "explain-item" | "refine-knowledge" | "agent-chat";
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
  questions?: string[];
}

export interface ArtifactSpec {
  artifactTypeRef: Ref;
  workItemRef: Ref;
  producedBy?: { agentRunRef: Ref; agentRef: Ref };
  format: string;
  content: string;
}
export type Artifact = Resource<ArtifactSpec>;

export interface ClarificationSpec {
  workItemRef: Ref;
  stage: string;
  questions: string[];
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
  verification?: {
    kind: "plan" | "candidate" | "waiver";
    fingerprint: string;
    planFingerprint: string;
    requirements?: string[];
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
}
export type Workspace = Resource<WorkspaceSpec, WorkspaceStatus>;
