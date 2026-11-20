import type { Conversation, IssueProposal, WorkItem } from "../model/kinds.ts";
import type { NewWorkItemInput, Principal } from "./app.ts";
import type { TranscriptAuthor } from "./transcripts.ts";

export interface FollowUpPreview {
  revision: string;
  instructions: string;
  snapshot: NonNullable<WorkItem["spec"]["originSnapshot"]>;
}

export interface NewFollowUpInput extends NewWorkItemInput {
  /** Required for a retrospective handoff into a workflow that publishes. Not inherited approval. */
  authorizePublication?: boolean;
  requestId: string;
  expectedRevision: string;
  workflowRef: string;
  repositoryRefs: string[];
}

export interface FollowUpRelations {
  origin?: { name: string; title?: string; available: boolean };
  items: WorkItem[];
}

export interface WorkItemFollowUpQueries {
  previewWorkItemFollowUp(p: Principal, name: string, context?: string): Promise<FollowUpPreview>;
  workItemFollowUps(p: Principal, name: string): Promise<FollowUpRelations>;
}

export interface NewFollowUpTicketInput {
  requestId: string;
  expectedRevision: string;
  title: string;
  /** Reviewed instructions (same text the preview was computed with). */
  instructions?: string;
  /** ADR-0076: the reviewed ticket body; the origin links are appended by the server. Absent: a short template. */
  body?: string;
  /** ADR-0076: the `draft-ticket` conversation the body came from (provenance only). */
  draftConversation?: string;
  targetSource: string;
  issueType?: string;
  labels?: string[];
}

export interface DraftFollowUpTicketInput {
  /** The preview revision the human reviewed; the draft is computed from exactly that evidence. */
  expectedRevision: string;
  instructions?: string;
  targetSource: string;
  title?: string;
  /** Redraft: the current, possibly edited draft and what to change. */
  previous?: { title: string; body: string };
  feedback?: string;
  /** Continue recording in this `draft-ticket` conversation (one per dialog). */
  conversation?: string;
}

export interface FollowUpTicketDraft {
  title: string;
  body: string;
  /** `template` when no agent drafted (e.g. no LLM); `reason` says why. */
  draftedBy: "agent" | "template";
  agent?: string;
  model?: string;
  reason?: string;
  conversation: string;
}

/** ADR-0076: side-effect free apart from the drafting transcript; the human edits and creates (rule 8). */
export interface FollowUpTicketDrafting {
  draftFollowUpTicket(p: Principal, name: string, input: DraftFollowUpTicketInput): Promise<FollowUpTicketDraft>;
}

export interface TicketDraftRequest {
  namespace: string;
  originTitle: string;
  originDescription?: string;
  instructions: string;
  /** Redacted, bounded evidence snapshot (ADR-0039). */
  evidence: string;
  target: { source: string; type: string; project?: string; issueType?: string };
  title?: string;
  previous?: { title: string; body: string };
  feedback?: string;
}

/** Writes a concise ticket from reviewed evidence into the given conversation's transcript (ADR-0076). */
export interface FollowUpTicketDrafter {
  /** The drafting agent (recorded as the conversation's agentRef and in the proposal's provenance). */
  readonly agent: string;
  draft(conversation: Conversation, request: TicketDraftRequest, author: TranscriptAuthor): Promise<Omit<FollowUpTicketDraft, "conversation">>;
}

export interface StartImplementationInput {
  workflowRef?: string;
  repositories?: string[];
}

export interface WorkItemFollowUpCommands {
  /** ADR-0068: explicit; creates (or returns) the work item for a created ticket, carrying origin and snapshot. */
  startImplementation(p: Principal, proposalName: string, input?: StartImplementationInput): Promise<WorkItem>;
  /** ADR-0068: the click is the approval; the ticket is created by the issue controller. */
  createFollowUpTicket(p: Principal, name: string, input: NewFollowUpTicketInput): Promise<IssueProposal>;
  createWorkItemFollowUp(p: Principal, name: string, input: NewFollowUpInput): Promise<WorkItem>;
}
