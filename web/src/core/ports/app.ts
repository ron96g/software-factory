/**
 * Application-service ports: the use cases the UI/API call. Every call takes a Principal
 * (auth-ready, ADR-0009); until v0.4 it is `anonymous`.
 */
import type {
  KnowledgeEntry,
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  Source,
  WorkItem,
  Workspace,
  OutboxMessage,
} from "../model/kinds.ts";
import type { Resource } from "../model/resource.ts";
import type { TranscriptMessage } from "./transcripts.ts";
import type { SandboxHealthInfo } from "./sandbox.ts";
import type { FailingReconcile } from "./runtime.ts";

export interface Principal {
  id: string;
  roles: string[];
  squads: string[];
}

export const ANONYMOUS: Principal = { id: "anonymous", roles: [], squads: [] };

export interface NewWorkItemInput {
  title: string;
  description?: string;
  /** Extra context from the team (Markdown), shown to every agent (ADR-0032). */
  context?: string;
  /** Default: the `manual` source's workflow. */
  workflowRef?: string;
  /** Default: the `manual` source's repositories. */
  repositoryRefs?: string[];
}

export interface NewItemChoice {
  name: string;
  description?: string;
}

/** What a human can pick when creating an item, plus the defaults the `manual` source would apply. */
export interface NewItemOptions {
  /** Top-level workflows (sub-workflows such as a Bolt are not offered). */
  workflows: NewItemChoice[];
  /** Repositories agents can actually read (MVP: with a local checkout, ADR-0008). */
  repositories: NewItemChoice[];
  defaults: { workflow?: string; repositories: string[] };
}

export interface NewItemOptionsQuery {
  newItemOptions(p: Principal): Promise<NewItemOptions>;
}

export interface WorkItemDetail {
  workItem: WorkItem;
  runs: AgentRun[];
  artifacts: Artifact[];
  clarifications: Clarification[];
  approvals: Approval[];
  conversations: Conversation[];
  workspaces: Workspace[];
  /** Outbound effects (comments, pull requests) and their delivery status/result. */
  outbox: OutboxMessage[];
  /** Evidence for human gates, derived from the latest round (ADR-0027). */
  evidence: GateEvidence;
  events: FactoryEvent[];
  /** Stage names of the compiled workflow, in order (for progress display). */
  stages: { name: string; lifecyclePhase: string; gate?: string }[];
  /** Knowledge proposed by this item's runs (ADR-0030). */
  knowledge: KnowledgeEntry[];
}

export interface WorkItemQueries {
  listWorkItems(p: Principal): Promise<WorkItem[]>;
  getWorkItem(p: Principal, name: string): Promise<WorkItemDetail | null>;
}

export interface WorkItemCommands {
  createWorkItem(p: Principal, input: NewWorkItemInput): Promise<WorkItem>;
  /** Deletes the item and everything it owns (runs, artifacts, workspaces …). */
  deleteWorkItem(p: Principal, name: string): Promise<void>;
  /**
   * Re-runs the workflow from `stage` (default: first stage) in a new round, also for finished items.
   * Earlier output of the restarted stages is kept as superseded history and no longer used as agent input.
   */
  restartWorkItem(p: Principal, name: string, stage?: string): Promise<WorkItem>;
  /** Sets the human-provided additional context (ADR-0032). Runs that already finished keep what they saw. */
  updateWorkItemContext(p: Principal, name: string, context: string): Promise<WorkItem>;
}

export type EvidenceSeverity = "ok" | "warning" | "blocking";

export interface EvidenceItem {
  severity: EvidenceSeverity;
  /** e.g. "Verification verdict", "Check: build". */
  label: string;
  detail: string;
  stage?: string;
  /** Run that produced it (for linking to the transcript). */
  runName?: string;
}

export interface GateEvidence {
  status: EvidenceSeverity;
  items: EvidenceItem[];
}

export interface HumanActions {
  answerClarification(p: Principal, name: string, answers: string[]): Promise<Clarification>;
  /**
   * ADR-0027: approving while the item's evidence is `blocking` requires `override: true` and a reason (comment ≥ 10 chars).
   */
  decideApproval(p: Principal, name: string, decision: "approve" | "reject", comment?: string, override?: boolean): Promise<Approval>;
}

export interface SourceActions {
  listSources(p: Principal): Promise<Source[]>;
  syncSource(p: Principal, name: string): Promise<{ created: number; updated: number }>;
}

export interface TranscriptQueries {
  runTranscript(p: Principal, runName: string): Promise<TranscriptMessage[]>;
}

export interface ConversationActions {
  startConversation(p: Principal, runName: string): Promise<Conversation>;
  conversationMessages(p: Principal, name: string): Promise<TranscriptMessage[]>;
  sendMessage(p: Principal, name: string, text: string): Promise<TranscriptMessage>;
}

export interface DefinitionQueries {
  listDefinitions(p: Principal, kind: string): Promise<Resource[]>;
}

export interface ReplayActions {
  /** Re-runs a past AgentRun with the same spec (ADR-0012). Never changes the work item's state. */
  rerun(p: Principal, runName: string): Promise<AgentRun>;
}

export interface SystemHealth {
  sandbox: SandboxHealthInfo;
  sandboxCandidates: SandboxHealthInfo[];
  /** Whether any ModelProvider resolves (else agents run deterministic/simulated). */
  llm: { available: boolean; provider?: string; model?: string };
  /** ADR-0029: what happens when no real executor fits a run (`allow` = simulated output, `wait` = run stays Pending). */
  simulation: "allow" | "wait";
  /** Reconciles that keep failing (Q2). */
  failing: FailingReconcile[];
}

export interface SystemQueries {
  systemHealth(p: Principal): Promise<SystemHealth>;
}

export interface BrowsableKind {
  kind: string;
  plural: string;
  scope: "definition" | "runtime";
  count: number;
}

/** Generic, read-only browsing of every registered kind (UI navigation). */
export interface ResourceBrowser {
  browsableKinds(p: Principal): Promise<BrowsableKind[]>;
  listResources(p: Principal, plural: string): Promise<Resource[]>;
  getResource(p: Principal, plural: string, name: string): Promise<Resource | null>;
}

/** X4: a read-only conversation about the whole work item (all runs, artifacts, human input, events). */
export interface ItemConversationActions {
  startItemConversation(p: Principal, workItem: string): Promise<Conversation>;
}

export interface KnowledgeDetail {
  entry: KnowledgeEntry;
  conversations: Conversation[];
}

/** ADR-0030: humans review and edit knowledge; approval is always a human action. */
export interface KnowledgeActions {
  listKnowledge(p: Principal): Promise<KnowledgeEntry[]>;
  getKnowledge(p: Principal, name: string): Promise<KnowledgeDetail | null>;
  /** Editing a rejected entry puts it back to Proposed. */
  updateKnowledge(p: Principal, name: string, patch: { title?: string; content?: string; tags?: string[] }): Promise<KnowledgeEntry>;
  reviewKnowledge(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<KnowledgeEntry>;
  retireKnowledge(p: Principal, name: string): Promise<KnowledgeEntry>;
  /** A human (or their agent harness, ADR-0034) proposes an entry. Always `Proposed`; approval stays in the UI. */
  proposeKnowledge(p: Principal, input: { title: string; content: string; tags?: string[]; repositories?: string[]; workflows?: string[] }): Promise<KnowledgeEntry>;
  /** Chat with the proposing agent to refine the entry (side-effect free; the human applies drafts). */
  startKnowledgeConversation(p: Principal, name: string): Promise<Conversation>;
}
