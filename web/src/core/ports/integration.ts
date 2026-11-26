/**
 * Integration ports (Ports & Adapters). Each capability is its own interface (ISP),
 * so a connector only implements what its external system supports.
 */
import type { KnowledgeSearcher } from "./knowledge.ts";
import type { ModelProvider, Repository, Source, SourceHistory, Workspace } from "../model/kinds.ts";
import type { OwnerReference, Ref } from "../model/resource.ts";
import type { CandidateCommit, FileReader, FileWriter, SandboxArtifacts, SandboxExec } from "./sandbox.ts";

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
  /** ADR-0094: set by pull request connectors; sync copies it into `WorkItem.spec.pullRequest`. */
  pullRequest?: import("../model/kinds.ts").PullRequestRef;
}

/** Capability: pull items from the external system. */
export interface ItemFetcher {
  fetchItems(source: Source): Promise<ExternalItem[]>;
}

/** What a connector returns as an item's history; sync adds `fetchedAt` and the echo flag. */
export type ExternalItemHistory = Omit<SourceHistory, "fetchedAt">;

/**
 * Capability: an item's full conversation and change history (ADR-0070). Connectors that implement it make the
 * history mandatory: sync never imports or updates an item without it. Throw when it can't be read completely.
 */
export interface ItemHistoryFetcher {
  fetchHistory(source: Source, externalId: string): Promise<ExternalItemHistory>;
}

/** Capability: write a comment back (clarification questions, status). */
export interface CommentPublisher {
  postComment(source: Source, externalId: string, body: string): Promise<void>;
}

/** Capability: read human replies (answers to clarifications). */
export interface CommentReader {
  listComments(source: Source, externalId: string, since?: string): Promise<{ author: string; body: string; createdAt: string }[]>;
}

/** ADR-0094: one review on a pull request. `marker` is a hidden idempotency marker kept in the body. */
export interface PullRequestReviewInput {
  commitSha: string;
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  body: string;
  marker: string;
  /** Inline comments posted with the review (GitHub `comments[]`); every one must be on a line of the diff. */
  comments?: { path: string; line: number; side: "RIGHT" | "LEFT"; start_line?: number; start_side?: "RIGHT" | "LEFT"; body: string }[];
  /** Body to post without `comments` when GitHub refuses them (all findings in the body). */
  fallbackBody?: string;
}

/** Capability (ADR-0094): post a pull request review, or return the existing one carrying the same marker. */
export interface PullRequestReviewPublisher {
  publishReview(source: Source, externalId: string, review: PullRequestReviewInput): Promise<{ id: string; url?: string; event: string; existing: boolean; inlineComments?: number }>;
}

/** A connector is identified by type and exposes any subset of capabilities. */
export interface SourceConnector {
  readonly type: string;
}

export const canFetch = (c: SourceConnector): c is SourceConnector & ItemFetcher =>
  typeof (c as Partial<ItemFetcher>).fetchItems === "function";
export const canFetchHistory = (c: SourceConnector): c is SourceConnector & ItemHistoryFetcher =>
  typeof (c as Partial<ItemHistoryFetcher>).fetchHistory === "function";
export const canComment = (c: SourceConnector): c is SourceConnector & CommentPublisher =>
  typeof (c as Partial<CommentPublisher>).postComment === "function";
export const canReadComments = (c: SourceConnector): c is SourceConnector & CommentReader =>
  typeof (c as Partial<CommentReader>).listComments === "function";

export const canPublishReview = (c: SourceConnector): c is SourceConnector & PullRequestReviewPublisher =>
  typeof (c as Partial<PullRequestReviewPublisher>).publishReview === "function";

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
  /** Surrounding lines when requested: `[lineNumber, text]` pairs in file order, excluding the hit itself. */
  context?: [number, string][];
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

/**
 * The model is temporarily unavailable: quota exhausted, rate limited, or overloaded (HTTP 429/503/529).
 * Not a failure of the run: callers wait and retry (`retryAfterMs` when the provider says how long).
 */
export class ModelUnavailableError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isModelUnavailable = (e: unknown): e is ModelUnavailableError => e instanceof ModelUnavailableError;

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

/** Conversation of a tool loop: plain chat plus assistant tool calls and tool results. */
export type ToolLoopMessage =
  | ChatMessage
  | { role: "assistant"; content?: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolCallingLLM {
  completeWithTools(req: { messages: ToolLoopMessage[]; tools: ToolSchema[]; tier?: string }): Promise<{ text?: string; toolCalls: ToolCall[]; usage?: TokenUsage }>;
}

/** Provider-reported token usage for one model call (ADR-0052). Missing means the provider did not report it. */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** Tool calling is an optional client capability (ISP), detected at runtime. */
export const canCallTools = (c: LLMClient): c is LLMClient & ToolCallingLLM =>
  typeof (c as Partial<ToolCallingLLM>).completeWithTools === "function";

/** Builds a client for a ModelProvider definition. Registered by `ModelProvider.spec.type`. */
export interface LLMClientFactory {
  create(provider: ModelProvider, apiKey: string | undefined): LLMClient;
}

/**
 * Where a resolved model is served, for runtimes that call the provider themselves (ADR-0060). The key comes from
 * `SecretResolver`; holders must never put it into prompts, transcripts or command environments (rule 16).
 */
export interface ModelEndpoint {
  /** `ModelProvider.spec.type`, e.g. "openai-compatible" | "anthropic". */
  type: string;
  /** `ModelProvider.spec.baseUrl` as configured; undefined means the provider type's default. */
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedModel {
  provider: string;
  providerType: string;
  model: string;
  tier: string;
  /** How the model was chosen: per-agent mapping or tier. */
  selectedBy?: "agent" | "tier";
  client: LLMClient;
  endpoint?: ModelEndpoint;
}

/** Maps a tier (+ optional explicit provider) to a concrete client & model. Undefined when none is configured. */
export interface ModelResolver {
  /** `agent` selects a per-agent model from the provider's `agentModels` (ADR-0028); otherwise the tier decides. */
  resolve(input: { namespace: string; tier?: string; providerRef?: Ref; agent?: string }): Promise<ResolvedModel | undefined>;
}

// ── Agent tools (ADR-0016): registered, read-only in the MVP ─────────────

export interface AgentToolInfo {
  readonly name: string;
  readonly readOnly: boolean;
  readonly description: string;
  /** Capabilities the tool is bound to. Nothing else is passed to `bind` (ISP). */
  readonly capabilities?: readonly (keyof ToolCapabilities)[];
  /** ADR-0057: trusted, static harness text: when the tool helps and one example call. Rendered in the tool guide. */
  readonly guidance?: string;
}

/** Code search over the item's workspaces; hits cite `repo:path:line`. */
export interface CodeSearcher {
  /** `context` adds up to that many surrounding lines to each hit (ADR-0057). */
  searchCode(query: string, options?: { glob?: string; maxHits?: number; context?: number }): Promise<CodeHit[]>;
}

/**
 * Capabilities a tool may be bound to; each tool takes only what it needs (ISP).
 * `read` and `search` come from the workspace (no sandbox needed); `exec`, `write`, `artifacts` only from a sandbox.
 */
export interface ToolCapabilities {
  checks?: { run(input: { workspace: string; check: string; requestId: string }): Promise<import("../model/kinds.ts").CheckRun> };
  checkLogs?: { read(input: { checkRun: string; afterSeq?: number; offset?: number }):
    Promise<{ content: string; seq?: number; next: { afterSeq: number; offset: number } | null; logsIncomplete: boolean }> };
  baseline?: { run(input: { workspace: string; check: string; requestId: string }): Promise<import("../model/kinds.ts").CheckRun> };
  read?: FileReader;
  search?: CodeSearcher;
  /** ADR-0030: approved knowledge + docs, already scoped to the run's repositories/workflow. Read-only. */
  knowledge?: KnowledgeSearcher;
  write?: FileWriter;
  exec?: SandboxExec;
  artifacts?: SandboxArtifacts;
  /** ADR-0080 §7: agent-initiated HTTP through the factory's allowlisted, audited egress proxy. */
  egress?: { fetch(req: import("./egress.ts").EgressRequest): Promise<import("./egress.ts").EgressResponse> };
}

/** Capabilities that require a sandbox runtime (ADR-0019). */
export const SANDBOX_CAPABILITIES: readonly (keyof ToolCapabilities)[] = ["write", "exec", "artifacts"];

/** Read-only, path-guarded access to the item's Ready workspaces (ADR-0021), without a sandbox. */
export interface WorkspaceReaderFactory {
  forWorkspaces(workspaces: Workspace[]): FileReader & CodeSearcher;
}

export interface BoundTool {
  readonly schema: ToolSchema;
  /** Returns the tool result as text for the model (and the transcript). */
  invoke(args: Record<string, unknown>): Promise<string>;
}

/** A registered agent tool. Context-only tools (e.g. code-search) have no `bind`. */
export interface AgentTool extends AgentToolInfo {
  bind?(caps: ToolCapabilities): BoundTool;
}

// ── Outbox (outbound side effects) ───────────────────────────────────────

export interface OutboxDelivery {
  namespace: string;
  /** Resolved source, when the message targets a source item. */
  source?: Source;
  externalId?: string;
  payload: Record<string, unknown>;
}

/** Delivers one outbox action type (e.g. "comment", "open-pull-request"). May return a result (e.g. `{ url }`). */
export interface OutboxHandler {
  readonly action: string;
  deliver(msg: OutboxDelivery): Promise<Record<string, unknown> | void>;
}

export interface OutboundMessage {
  /** Deterministic idempotency key (becomes the OutboxMessage name). Enqueueing twice is a no-op. */
  key: string;
  namespace: string;
  source?: string;
  externalId?: string;
  action: string;
  payload: Record<string, unknown>;
  /** Owner for cascade delete (usually the WorkItem). */
  owner?: OwnerReference;
}

/** Enqueues outbound messages (persisted, delivered asynchronously with retries, ADR-0005). */
export interface Outbox {
  enqueue(msg: OutboundMessage): Promise<void>;
}

/** Marker appended to every comment the factory writes, so inbound sync ignores its own comments. */
export const FACTORY_COMMENT_MARKER = "<!-- software-factory -->";

// ── Workspaces (ADR-0021) ───────────────────────────────────────────────

export interface PreparedWorkspace {
  path: string;
  baseCommit: string;
  headCommit: string;
  preparedBy: string;
  setupLog?: string;
  /** Setup ran to completion (a crash mid-setup re-runs it). */
  setupCompleted: boolean;
}

/** Whether this backend can provide workspaces for a repository (e.g. needs a local path). */
export interface WorkspaceSupport {
  supports(repo: Repository): boolean;
}

/** Creates (or re-attaches to) the files of a Workspace, pins its base commit, runs setup. Idempotent. */
export interface WorkspacePreparer {
  prepare(ws: Workspace, repo: Repository): Promise<PreparedWorkspace>;
}

/**
 * Whether a Workspace's files are still present (ADR-0021). A `Ready` workspace whose directory vanished (a manual
 * cleanup, a crash, a concurrent sweep) is re-prepared instead of failing every git call with `ENOENT`.
 */
export interface WorkspaceProbe {
  exists(ws: Workspace): boolean;
}

/** Removes the files of a deleted Workspace. Idempotent. */
export interface WorkspaceCleaner {
  remove(ws: Workspace, repo: Repository | null): Promise<void>;
}

/** Level-triggered cleanup: removes workspace files whose resource no longer exists. Returns removed paths. */
export interface WorkspaceSweeper {
  sweep(live: { workItem: string; repository: string }[]): Promise<string[]>;
}

// ── Checks & publishing (ADR-0023) ──────────────────────────────────────

/** Runs a command in a workspace through the selected sandbox runtime. */
export interface CommandRunner {
  run(workspace: Workspace, repositories: Repository[], command: string, timeoutMs?: number): Promise<{ exitCode: number; output: string; durationMs: number }>;
}

/** Commits the workspace's changes and pushes its branch. Idempotent (no-op commit if nothing changed). */
export interface BranchPublisher {
  publish(ws: Workspace, repo: Repository, message: string): Promise<{ branch: string; commit: string; pushed: boolean }>;
}

/**
 * ADR-0092: produces the publication commit of a workspace as an untrusted bundle, made where the repository's code may
 * run (the sandbox), never in the factory process. `outDir` is factory-owned scratch the caller removes.
 */
export interface CandidateCommitter {
  commit(ws: Workspace, repo: Repository, input: { message: string; outDir: string }): Promise<CandidateCommit>;
}

/** ADR-0092: a registered commit message format (`Repository.spec.git.commit.convention`). */
export interface CommitMessageConvention {
  readonly type: string;
  /** `classification`: the work item's classified type (e.g. `bug`, `feature`), when known. */
  format(input: { title: string; workItem: string; classification?: string }): string;
}

// ── Base-branch conflicts (ADR-0053) ────────────────────────────────────

export interface BaseConflictReport {
  /** Commit of the remote base branch the candidate was compared with. */
  baseCommit: string;
  /** Files that do not merge cleanly, or still contain conflict markers. Empty: publishable. */
  conflicts: string[];
}

/** Read-only: does the workspace's current candidate merge cleanly into the remote base branch? */
export interface BaseConflictDetector {
  detect(ws: Workspace, repo: Repository, baseBranch: string): Promise<BaseConflictReport>;
}

/** Merges a base commit into the workspace, leaving conflict markers for an agent or human to resolve. Idempotent. */
export interface WorkspaceIntegrator {
  integrate(ws: Workspace, repo: Repository, baseCommit: string): Promise<{ baseCommit: string; headCommit: string; conflicts: string[] }>;
}

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** A code host (GitHub, GitLab, …), selected by the repository's git URL. */
export interface CodeHost {
  readonly type: string;
  matches(repo: Repository): boolean;
  /** Opens a PR, or returns the existing open PR for the same head branch. */
  openPullRequest(repo: Repository, input: PullRequestInput): Promise<{ url: string; number: number; created: boolean }>;
}
