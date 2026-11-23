/**
 * ADR-0080 §4: the model proxy. A runtime never receives a provider key; it receives a **run-scoped token** bound to one
 * `AgentRun`, with a model allowlist, budgets, a TTL and revocation. The proxy is strictly model-shaped — no generic
 * fetch or forward — so it cannot become an egress channel, and it is the authoritative control point for step budgets,
 * usage accounting (ADR-0052) and quota waits (ADR-0031).
 *
 * The ports here are ISP-split: `ModelTokenStore` (issue/verify/charge/revoke) and `ModelProxy` (serve a request).
 */
import type { Ref } from "../model/resource.ts";

/** What a run-scoped token authorizes. Issued by the factory, never by the runtime. */
export interface ModelProxyGrant {
  /** The one `AgentRun` this token is bound to. */
  run: Ref;
  namespace: string;
  /** The `ModelProvider` the run may call. */
  providerRef: Ref;
  /** Per-agent model mapping key (ADR-0028), if any. */
  agent?: string;
  tier?: string;
  /** Model ids the run may request. The proxy refuses anything else. */
  models: string[];
  /** Maximum model calls; the proxy refuses past it. */
  maxCalls?: number;
  /** Maximum tokens (prompt + completion); the proxy refuses past it. */
  maxTokens?: number;
  /** ISO timestamp; the proxy refuses after it. */
  expiresAt: string;
}

/** A grant plus its live counters, returned by the store. */
export interface ModelProxyGrantState extends ModelProxyGrant {
  token: string;
  issuedAt: string;
  calls: number;
  tokens: number;
  revoked: boolean;
}

/** Issues, verifies, charges and revokes run-scoped model tokens. */
export interface ModelTokenStore {
  issue(grant: ModelProxyGrant): Promise<ModelProxyGrantState>;
  verify(token: string): Promise<ModelProxyGrantState | undefined>;
  /** Adds usage to the token's counters; returns the updated state (undefined when unknown/revoked). */
  charge(token: string, usage: { calls: number; tokens: number }): Promise<ModelProxyGrantState | undefined>;
  revoke(token: string): Promise<void>;
  /** Revokes every token bound to a run (called when the run ends). Returns how many were revoked. */
  revokeRun(run: Ref): Promise<number>;
}

/** A minimal OpenAI-shaped chat request (ADR-0080 §4: the proxy accepts only model-shaped input). */
export interface ModelProxyRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  response_format?: unknown;
  [key: string]: unknown;
}

export interface ModelProxyUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelProxyResult {
  /** The provider's response, passed through to the caller. */
  body: unknown;
  usage?: ModelProxyUsage;
}

/** Serves model calls for a run, enforcing the token's scope and budgets. */
export interface ModelProxy {
  chatCompletions(token: string, request: ModelProxyRequest): Promise<ModelProxyResult>;
}

/** A proxy refusal, mapped to HTTP by the surface. */
export class ModelProxyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
