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
  checks?: Record<string, string>;
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
  /** Human request to re-run the workflow from `stage` (default: first stage). A new `id` triggers it once. */
  restart?: { id: string; stage?: string; requestedBy?: string };
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
  /** Set for conversations about a work item (`explain`, `explain-item`). */
  workItemRef?: Ref;
  /** Set for `explain` (one run); absent for `explain-item` (the whole work item, X4). */
  agentRunRef?: Ref;
  agentRef?: Ref;
  /** Set for `refine-knowledge` (ADR-0030). */
  knowledgeRef?: Ref;
  /** Selects the registered ConversationResponder. */
  purpose: "explain" | "explain-item" | "refine-knowledge";
  startedBy?: string;
}
export interface ConversationStatus {
  transcriptRef?: { namespace: string; id: string };
  messageCount?: number;
  lastMessageAt?: string;
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
  phase: "Pending" | "Delivered" | "Failed";
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
