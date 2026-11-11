/**
 * Typed spec/status shapes per kind.
 * Definitions mirror the YAML/Markdown in the repo. Runtime kinds live in the store.
 */
import type { Condition, DocumentResource, Ref, Resource } from "./resource.ts";

// ── Definitions ──────────────────────────────────────────────────────────

export interface AgentSpec {
  role: string;
  model?: { tier?: string; providerRef?: Ref };
  skillRefs?: Ref[];
  delegates?: { agentRef: Ref }[];
  tools?: string[];
  humanCounterpart?: { role: string };
}
export type Agent = DocumentResource<AgentSpec>;

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
}
export type Repository = Resource<RepositorySpec>;

export interface ModelProviderSpec {
  type: string; // "openai-compatible" | "anthropic" | …
  baseUrl?: string;
  secretRef?: Ref;
  models: Record<string, string>; // tier → model
  default?: boolean;
}
export type ModelProvider = Resource<ModelProviderSpec>;

// ── Runtime ──────────────────────────────────────────────────────────────

export type WorkItemPhase =
  | "New"
  | "Running"
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
  sourceRef: Ref;
  externalRef?: { id: string; url?: string };
  workflowRef?: Ref;
  repositoryRefs?: Ref[];
}

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
}

export interface ConversationSpec {
  workItemRef: Ref;
  agentRunRef: Ref;
  agentRef: Ref;
  purpose: "explain";
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
  sourceRef: Ref;
  externalId: string;
  action: string; // e.g. "comment"
  payload: Record<string, unknown>;
}
export interface OutboxMessageStatus {
  phase: "Pending" | "Delivered" | "Failed";
  attempts?: number;
  lastError?: string;
  nextAttemptAt?: string;
}
export type OutboxMessage = Resource<OutboxMessageSpec, OutboxMessageStatus>;
