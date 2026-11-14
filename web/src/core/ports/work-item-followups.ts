import type { WorkItem } from "../model/kinds.ts";
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

export interface WorkItemFollowUpCommands {
  createWorkItemFollowUp(p: Principal, name: string, input: NewFollowUpInput): Promise<WorkItem>;
}
