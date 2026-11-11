/**
 * Integration ports (Ports & Adapters). Each capability is its own interface (ISP),
 * so a connector only implements what its external system supports.
 */
import type { ModelProvider, Repository, Source } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";

// ── Generic registry (adapter lookup by `type`) ─────────────────────────

export interface Lookup<T> {
  get(key: string): T | undefined;
  keys(): string[];
}

export interface Registrar<T> {
  register(key: string, impl: T): void;
}

// ── Secrets ──────────────────────────────────────────────────────────────

export interface SecretResolver {
  resolve(ref: Ref | undefined): string | undefined;
}

// ── Sources (Jira, GitHub, …) ───────────────────────────────────────────

/** Normalized external item (anti-corruption layer output). */
export interface ExternalItem {
  externalId: string;
  url?: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: string;
  updatedAt?: string;
}

/** Capability: pull items from the external system. */
export interface ItemFetcher {
  fetchItems(source: Source): Promise<ExternalItem[]>;
}

/** Capability: write a comment back (clarification questions, status). */
export interface CommentPublisher {
  postComment(source: Source, externalId: string, body: string): Promise<void>;
}

/** Capability: read human replies (answers to clarifications). */
export interface CommentReader {
  listComments(source: Source, externalId: string, since?: string): Promise<{ author: string; body: string; createdAt: string }[]>;
}

/** A connector is identified by type and exposes any subset of capabilities. */
export interface SourceConnector {
  readonly type: string;
}

export const canFetch = (c: SourceConnector): c is SourceConnector & ItemFetcher =>
  typeof (c as Partial<ItemFetcher>).fetchItems === "function";
export const canComment = (c: SourceConnector): c is SourceConnector & CommentPublisher =>
  typeof (c as Partial<CommentPublisher>).postComment === "function";
export const canReadComments = (c: SourceConnector): c is SourceConnector & CommentReader =>
  typeof (c as Partial<CommentReader>).listComments === "function";

/** Imports external items as WorkItems (used by sync controller and "Sync now"). */
export interface SourceSyncer {
  sync(sourceName: string): Promise<{ created: number; updated: number }>;
}

// ── Repositories & code search ───────────────────────────────────────────

/** Provides a local, readable checkout of a Repository. */
export interface WorkspaceProvider {
  checkout(repo: Repository): Promise<string>;
}

export interface CodeHit {
  repository: string;
  path: string;
  line: number;
  text: string;
  term: string;
}

export interface CodeSearchQuery {
  terms: string[];
  maxHitsPerTerm?: number;
}

export interface CodeSearch {
  search(repo: Repository, root: string, query: CodeSearchQuery): Promise<CodeHit[]>;
}

// ── LLM ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tier?: string;
  json?: boolean;
}

export interface LLMClient {
  complete(req: CompletionRequest): Promise<string>;
}

// ── Tool calling (ADR-0014): separate capability, not every client supports it ─

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallingLLM {
  completeWithTools(req: CompletionRequest & { tools: ToolSchema[] }): Promise<{ text?: string; toolCalls: ToolCall[] }>;
}

/** Builds a client for a ModelProvider definition. Registered by `ModelProvider.spec.type`. */
export interface LLMClientFactory {
  create(provider: ModelProvider, apiKey: string | undefined): LLMClient;
}

export interface ResolvedModel {
  provider: string;
  providerType: string;
  model: string;
  tier: string;
  client: LLMClient;
}

/** Maps a tier (+ optional explicit provider) to a concrete client & model. Undefined when none is configured. */
export interface ModelResolver {
  resolve(input: { namespace: string; tier?: string; providerRef?: Ref }): Promise<ResolvedModel | undefined>;
}

// ── Agent tools (ADR-0016): registered, read-only in the MVP ─────────────

export interface AgentToolInfo {
  readonly name: string;
  readonly readOnly: boolean;
  readonly description: string;
}

// ── Outbox (outbound side effects) ───────────────────────────────────────

/** Delivers one outbox action type (e.g. "comment") to a source. */
export interface OutboxHandler {
  readonly action: string;
  deliver(source: Source, externalId: string, payload: Record<string, unknown>): Promise<void>;
}

/** Enqueues outbound messages (persisted, delivered asynchronously with retries). */
export interface Outbox {
  enqueue(msg: { source: string; externalId: string; action: string; payload: Record<string, unknown> }): Promise<void>;
}
