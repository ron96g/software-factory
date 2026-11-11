/**
 * Transcript & conversation ports (ADR-0012).
 * Transcripts are append-only message logs, stored outside resource documents.
 */
import type { AgentRun, Conversation } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";

export type TranscriptRole = "system" | "user" | "assistant" | "tool-call" | "tool-result" | "note";

export interface TranscriptAuthor {
  type: "agent" | "human" | "system";
  /** Agent name, principal id (or "anonymous" until auth), or component name. */
  id: string;
}

export interface TranscriptMessage {
  /** Monotonic position within the transcript (assigned by the store). */
  seq: number;
  at: string;
  role: TranscriptRole;
  author: TranscriptAuthor;
  content: string;
  /** Tool name for tool-call / tool-result, delegated run ref, … */
  meta?: {
    tool?: string;
    delegatedRunRef?: Ref;
    tokens?: { prompt?: number; completion?: number };
    latencyMs?: number;
    [key: string]: unknown;
  };
}

export type NewTranscriptMessage = Omit<TranscriptMessage, "seq" | "at"> & { at?: string };

export interface TranscriptRef {
  namespace: string;
  id: string;
}

/** Append-only. There is intentionally no update or delete. */
export interface TranscriptWriter {
  open(namespace: string, owner: { kind: string; name: string }): Promise<TranscriptRef>;
  append(ref: TranscriptRef, message: NewTranscriptMessage): Promise<TranscriptMessage>;
}

export interface TranscriptReader {
  read(ref: TranscriptRef, options?: { afterSeq?: number; limit?: number }): Promise<TranscriptMessage[]>;
}

/** Live tail for the UI (SSE). Kept separate from reading (ISP). */
export interface TranscriptTail {
  tail(ref: TranscriptRef, listener: (message: TranscriptMessage) => void): () => void;
}

/** Bound to one transcript and handed to executors, so they can't write elsewhere. Redacts secrets. */
export interface TranscriptRecorder {
  readonly ref: TranscriptRef;
  record(message: NewTranscriptMessage): Promise<void>;
}

export interface TranscriptRecorderFactory {
  forRun(run: AgentRun): Promise<TranscriptRecorder>;
  forConversation(conversation: Conversation): Promise<TranscriptRecorder>;
}

/** Removes secret values before anything is persisted. */
export interface Redactor {
  redact(text: string): string;
}

// ── Replay ───────────────────────────────────────────────────────────────

/** Re-run mode: creates a NEW AgentRun from a previous run's provenance. Never mutates the original. */
export interface RunReplayer {
  rerun(original: AgentRun, overrides?: { modelTier?: string; model?: string; latestDefinitions?: boolean }): Promise<AgentRun>;
}

// ── Follow-up conversations ("ask the agent why") ────────────────────────

/** Answers a human message in a Conversation. Explain mode: side-effect free. */
export interface ConversationResponder {
  respond(conversation: Conversation, humanMessage: string, author: TranscriptAuthor): Promise<TranscriptMessage>;
}
