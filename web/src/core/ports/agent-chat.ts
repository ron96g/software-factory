import type { Agent, AgentRun, Approval, Artifact, Clarification, Conversation, FactoryEvent, WorkItem } from "../model/kinds.ts";
import type { NewWorkItemInput, Principal } from "./app.ts";
import type { BoundTool, ResolvedModel, ToolCall, ToolLoopMessage, ToolSchema } from "./integration.ts";
import type { TranscriptMessage, TranscriptRecorder } from "./transcripts.ts";

export interface AgentChatDetail {
  conversation: Conversation;
  messages: TranscriptMessage[];
}

export interface AgentChatQueries {
  chatAgents(p: Principal): Promise<Agent[]>;
  listAgentChats(p: Principal, workItem?: string): Promise<Conversation[]>;
  getAgentChat(p: Principal, name: string): Promise<AgentChatDetail | null>;
}

export interface AgentChatCommands {
  startAgentChat(p: Principal, agent: string, title?: string, workItem?: string): Promise<Conversation>;
  submitAgentChatTurn(p: Principal, name: string, input: { id: string; text: string }): Promise<Conversation>;
}

export interface ChatWorkItemCreator {
  createChatWorkItem(p: Principal, name: string, input: NewWorkItemInput): Promise<WorkItem>;
}

export interface WorkItemRecord {
  workItem: WorkItem;
  runs: AgentRun[];
  artifacts: Artifact[];
  clarifications: Clarification[];
  approvals: Approval[];
  events: FactoryEvent[];
}

/** Namespace-scoped evidence; reading it never executes or changes the workflow. */
export interface WorkItemRecordReader {
  read(namespace: string, name: string): Promise<WorkItemRecord>;
}

/** Registered by purpose; only the Conversation controller writes status. */
export interface ConversationTurnRunner {
  run(conversation: Conversation, transcript: TranscriptRecorder): Promise<void>;
}

export interface RecordedToolTurns {
  complete(input: {
    model: ResolvedModel; messages: ToolLoopMessage[]; tools: ToolSchema[];
    transcript: TranscriptRecorder; agent: string; step: number; turnId?: string;
    /** False when the caller uses an explicit completion protocol instead of plain text. */
    finalText?: boolean;
  }): Promise<{ text?: string; toolCalls: ToolCall[] }>;
  invoke(input: {
    call: ToolCall; tool?: BoundTool; transcript: TranscriptRecorder;
    agent: string; step: number; turnId?: string;
  }): Promise<string>;
}
