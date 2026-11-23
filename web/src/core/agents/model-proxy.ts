import { ModelProxyError, ModelUnavailableError, type ModelProxy, type ModelProxyRequest, type ModelProxyResult, type ModelProxyUsage, type ModelResolver, type ModelTokenStore } from "../ports/index.ts";
import { retryAfterMs } from "../adapters/llm/clients.ts";

type Fetch = typeof fetch;

/** Quota / rate limit (429), unavailable (503), Anthropic "overloaded" (529): a wait, not a failure (ADR-0031). */
const TRANSIENT = new Set([429, 503, 529]);

const usageOf = (json: unknown): ModelProxyUsage | undefined => {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })?.usage;
  if (!u) return undefined;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u.total_tokens ?? promptTokens + completionTokens };
};

/**
 * ADR-0080 §4: the factory's model proxy. It holds the provider key and speaks the openai-compatible dialect to the
 * provider, so a runtime that calls it never sees the key. It authenticates by a run-scoped token and enforces the
 * token's model allowlist, step/token budgets and TTL before forwarding; usage is charged to the token.
 */
export class DefaultModelProxy implements ModelProxy {
  private readonly tokens: ModelTokenStore;
  private readonly models: ModelResolver;
  private readonly f: Fetch;
  constructor(d: { tokens: ModelTokenStore; models: ModelResolver; fetch?: Fetch }) {
    this.tokens = d.tokens;
    this.models = d.models;
    this.f = d.fetch ?? fetch;
  }

  async chatCompletions(token: string, request: ModelProxyRequest): Promise<ModelProxyResult> {
    const grant = await this.tokens.verify(token);
    if (!grant) throw new ModelProxyError("unknown, revoked or expired model token", 401);
    if (!request.model || !grant.models.includes(request.model)) {
      throw new ModelProxyError(`model "${String(request.model)}" is not allowed for this run`, 403);
    }
    if (grant.maxCalls != null && grant.calls >= grant.maxCalls) {
      throw new ModelProxyError(`the run's step budget of ${grant.maxCalls} is used up`, 429);
    }
    if (grant.maxTokens != null && grant.tokens >= grant.maxTokens) {
      throw new ModelProxyError(`the run's token budget of ${grant.maxTokens} is used up`, 429);
    }

    const resolved = await this.models.resolve({ namespace: grant.namespace, tier: grant.tier, providerRef: grant.providerRef, agent: grant.agent });
    if (!resolved) throw new ModelProxyError("no model provider is configured for this run", 502);
    if (resolved.providerType !== "openai-compatible") {
      throw new ModelProxyError(`the proxy speaks the openai-compatible dialect; "${resolved.providerType}" is not supported yet (ADR-0080 open question)`, 501);
    }
    const baseUrl = (resolved.endpoint?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = resolved.endpoint?.apiKey;
    const res = await this.f(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ ...request, model: resolved.model }),
    });
    const text = await res.text();
    if (TRANSIENT.has(res.status)) {
      throw new ModelUnavailableError(`model proxy: provider HTTP ${res.status}`, res.status, retryAfterMs(res.headers.get("retry-after")));
    }
    if (!res.ok) throw new ModelProxyError(`provider HTTP ${res.status}: ${text.slice(0, 300)}`, 502);
    const json = JSON.parse(text) as unknown;
    const usage = usageOf(json);
    await this.tokens.charge(token, { calls: 1, tokens: usage?.totalTokens ?? 0 });
    return { body: json, usage };
  }
}
