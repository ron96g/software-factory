import type { IssueProposal, WorkItem } from "../model/kinds.ts";
import type { NewWorkItemInput, Principal } from "./app.ts";

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
  targetSource: string;
  issueType?: string;
  labels?: string[];
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
