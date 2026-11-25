/**
 * Application-service ports: the use cases the UI/API call. Every call takes a Principal
 * (auth-ready, ADR-0009); until v0.4 it is `anonymous`.
 */
import type {
  KnowledgeEntry,
  IssueProposal,
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  InlineFeedback,
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
  /** ADR-0066: also propose mirroring the item as an issue in this source (still needs human approval). */
  mirrorTo?: string;
  /** ADR-0084: tracker a workflow's `publish.issue` block creates the ticket in (default: the block's target). */
  ticketTarget?: string;
}

/** What a human can change together with a restart, so the re-run sees it (ADR-0085). */
export interface RestartOptions {
  /** Replaces the additional context (ADR-0032) in the same write as the restart. */
  context?: string;
  /** Submits the draft inline notes on the re-run stages in the restart's batch (ADR-0071, ADR-0073). */
  includeDraftNotes?: boolean;
}

export interface NewItemChoice {
  name: string;
  description?: string;
  /** ADR-0084: the workflow ends by publishing a ticket; `target` is its default tracker. */
  publishesTicket?: { target?: string };
}

/** What a human can pick when creating an item, plus the defaults the `manual` source would apply. */
export interface NewItemOptions {
  /** Top-level workflows (sub-workflows such as a Bolt are not offered). */
  workflows: NewItemChoice[];
  /** Repositories agents can actually read (MVP: with a local checkout, ADR-0008). */
  repositories: NewItemChoice[];
  defaults: { workflow?: string; repositories: string[] };
  /** ADR-0066: sources that permit creating issues ("Also create in …"). */
  issueTargets: { source: string; type: string; project?: string; issueType?: string; labels?: string[] }[];
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
  /** Stages of the compiled workflow, in order (progress and stage state display). */
  stages: { name: string; lifecyclePhase: string; gate?: string; steps: { name: string; agent: string }[]; publishes?: boolean }[];
  /** The item's repositories and whether their changes can be published as pull requests (ADR-0023). */
  repositories: { name: string; publishable: boolean }[];
  /** Knowledge proposed by this item's runs (ADR-0030). */
  knowledge: KnowledgeEntry[];
  /** Issues proposed for this item (ADR-0066). */
  issues: IssueProposal[];
  /** Inline feedback on artifacts with its derived state (ADR-0071). */
  feedback: FeedbackView[];
  /** What "Submit feedback" would do now; set while drafts exist. */
  feedbackPlan?: FeedbackPlan;
  /** Item capabilities (ADR-0075): which workflow-specific views apply, e.g. `checks`, `ticket-actions`. Sorted. */
  capabilities: string[];
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
  restartWorkItem(p: Principal, name: string, stage?: string, options?: RestartOptions): Promise<WorkItem>;
  /** Sets the human-provided additional context (ADR-0032). Runs that already finished keep what they saw. */
  updateWorkItemContext(p: Principal, name: string, context: string): Promise<WorkItem>;
}

/** A pull request the factory published for an item, compared with the current remote base (ADR-0054). */
export interface PublishedPullRequest {
  workspace: string;
  repository: string;
  url: string;
  number: number;
  base: string;
  /** Files that no longer merge cleanly into the base; empty when up to date or mergeable. */
  conflicts: string[];
  /** The comparison failed (e.g. workspace gone, remote unreachable). */
  error?: string;
}

/** ADR-0054: keep already published pull requests mergeable when the base branch moves on. */
export interface PullRequestMaintenance {
  publishedPullRequests(p: Principal, name: string): Promise<PublishedPullRequest[]>;
  /** Re-publishes from the workflow's publish stage; base conflicts route through ADR-0053 resolution. */
  updatePullRequest(p: Principal, name: string): Promise<WorkItem>;
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
  /** Artifacts that run read or produced, so a summary referring to them ("option 1 of the research notes") can be read at the gate. */
  artifacts?: { name: string; type: string; role: "input" | "output" }[];
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
  /** Checks repository policy relies on without a configured command (they can never pass). */
  policyGaps: import("../model/verification-policy.ts").PolicyGap[];
  /** ADR-0062 §3: live check workers (renewed `worker/…` heartbeats) and how many checks they run right now. */
  checks: { workers: number; running: number };
  /** ADR-0062 §3: the role this process runs as, so the UI can explain a missing check worker. */
  role: "all" | "web" | "worker";
  /** ADR-0088: profile-declared tools that are not in the toolchain cache yet, per repository. */
  toolGaps: { repository: string; tool: string; type: string }[];
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

/** ADR-0066: humans review issue proposals; agents and MCP can only propose (rule 8). */
export interface IssueReviewActions {
  listIssueProposals(p: Principal): Promise<IssueProposal[]>;
  /** Editing publishing fields or the target drops a previous decision. */
  updateIssueProposal(p: Principal, name: string, patch: { title?: string; body?: string; issueType?: string; labels?: string[]; pickUp?: boolean; targetSource?: string }): Promise<IssueProposal>;
  /** Approval is bound to the content hash of the publishing fields. */
  reviewIssueProposal(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<IssueProposal>;
  /** For Uncertain or Failed: create again, or link an existing issue. */
  resolveIssueProposal(p: Principal, name: string, input: { action: "create-again" | "link"; externalId?: string }): Promise<IssueProposal>;
}

/** ADR-0066: proposing issues. Approval, target choice and creation are deliberately not here (rule 8). */
export interface IssueProposalActions {
  listIssueTargets(p: Principal): Promise<{ source: string; type: string; project?: string; issueType?: string; labels?: string[] }[]>;
  proposeIssue(p: Principal, input: { title: string; body: string; issueType?: string; labels?: string[]; workItem?: string }): Promise<{ name: string }>;
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

export type FeedbackState = "draft" | "submitted" | "addressed";

export interface FeedbackView {
  feedback: InlineFeedback;
  state: FeedbackState;
  /** The run that received it (state `addressed`). */
  addressedBy?: string;
  /**
   * Drafts on an artifact that a newer current version replaced: `current` is that version, `quoteFound` whether the
   * quoted passage is still in it. The note is still sent with the version the human read.
   */
  outdated?: { current: string; quoteFound: boolean };
}

/**
 * ADR-0071: submitting drafts at an open human gate whose reject route re-runs the producing stage rejects that gate
 * (the comment says why); otherwise the item restarts from the earliest producing stage.
 */
export interface FeedbackPlan {
  action: "reject" | "restart";
  /** Stage that runs next (the reject route's target or the restart stage). */
  stage: string;
  /** Set for `reject`. */
  approval?: string;
  /** Agents that receive the notes. */
  agents: string[];
  drafts: number;
}

export interface NewFeedbackInput {
  /** Artifact name; it must belong to the work item and come from a real (non-replay) run. */
  artifact: string;
  quote: string;
  comment: string;
}

/** ADR-0071: humans annotate passages of artifacts, collect notes as drafts and submit them as one batch. */
export interface FeedbackActions {
  addFeedback(p: Principal, workItem: string, input: NewFeedbackInput): Promise<InlineFeedback>;
  /** Drafts only; submitted notes are part of the record. */
  updateFeedback(p: Principal, name: string, comment: string): Promise<InlineFeedback>;
  deleteFeedback(p: Principal, name: string): Promise<void>;
  submitFeedback(p: Principal, workItem: string): Promise<FeedbackPlan>;
}
