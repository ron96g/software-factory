/**
 * Application-service ports: the use cases the UI/API call. Every call takes a Principal
 * (auth-ready, ADR-0009); until v0.4 it is `anonymous`.
 */
import type {
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  Source,
  WorkItem,
} from "../model/kinds.ts";
import type { Resource } from "../model/resource.ts";
import type { TranscriptMessage } from "./transcripts.ts";

export interface Principal {
  id: string;
  roles: string[];
  squads: string[];
}

export const ANONYMOUS: Principal = { id: "anonymous", roles: [], squads: [] };

export interface NewWorkItemInput {
  title: string;
  description?: string;
  repositoryRefs?: string[];
}

export interface WorkItemDetail {
  workItem: WorkItem;
  runs: AgentRun[];
  artifacts: Artifact[];
  clarifications: Clarification[];
  approvals: Approval[];
  conversations: Conversation[];
  events: FactoryEvent[];
  /** Stage names of the compiled workflow, in order (for progress display). */
  stages: { name: string; lifecyclePhase: string; gate?: string }[];
}

export interface WorkItemQueries {
  listWorkItems(p: Principal): Promise<WorkItem[]>;
  getWorkItem(p: Principal, name: string): Promise<WorkItemDetail | null>;
}

export interface WorkItemCommands {
  createWorkItem(p: Principal, input: NewWorkItemInput): Promise<WorkItem>;
}

export interface HumanActions {
  answerClarification(p: Principal, name: string, answers: string[]): Promise<Clarification>;
  decideApproval(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<Approval>;
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
