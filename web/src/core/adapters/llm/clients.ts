import type { ModelProvider } from "../../model/kinds.ts";
import { ModelUnavailableError, type CompletionRequest, type LLMClient, type LLMClientFactory, type ToolCall, type ToolCallingLLM, type ToolLoopMessage, type ToolSchema } from "../../ports/index.ts";

type Fetch = typeof fetch;

/** Quota / rate limit (429), unavailable (503), Anthropic "overloaded" (529): wait and retry, don't fail. */
const TRANSIENT = new Set([429, 503, 529]);

/** `Retry-After`: seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function postJson(f: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (TRANSIENT.has(res.status)) {
    throw new ModelUnavailableError(`LLM HTTP ${res.status}: ${text.trim().slice(0, 300)}`, res.status, retryAfterMs(res.headers.get("retry-after")));
  }
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

const toOpenAI = (m: ToolLoopMessage) => {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if ("toolCalls" in m) {
    return {
      role: "assistant",
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
    };
  }
  return m;
};

/** OpenAI Chat Completions API and compatibles (Azure, Ollama, OpenRouter, vLLM, …). */
export class OpenAICompatibleClient implements LLMClient, ToolCallingLLM {
  private readonly baseUrl: string;
  private readonly model: (tier?: string) => string;
  private readonly apiKey?: string;
  private readonly f: Fetch;
  constructor(o: { baseUrl: string; model: (tier?: string) => string; apiKey?: string; fetch?: Fetch }) {
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.model = o.model;
    this.apiKey = o.apiKey;
    this.f = o.fetch ?? fetch;
  }
  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
  async complete(req: CompletionRequest): Promise<string> {
    const r = await postJson(this.f, `${this.baseUrl}/chat/completions`, this.headers(), {
      model: this.model(req.tier),
      messages: req.messages,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    });
    const choice = (r.choices as { message: { content: string } }[] | undefined)?.[0];
    return choice?.message.content ?? "";
  }
  async completeWithTools(req: { messages: ToolLoopMessage[]; tools: ToolSchema[]; tier?: string }) {
    const r = await postJson(this.f, `${this.baseUrl}/chat/completions`, this.headers(), {
      model: this.model(req.tier),
      messages: req.messages.map(toOpenAI),
      tools: req.tools.map((t) => ({ type: "function", function: t })),
    });
    const msg = (r.choices as { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[])[0]
      .message;
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: safeJson(c.function.arguments) }));
    return { text: msg.content ?? undefined, toolCalls };
  }
}

const safeJson = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
};

/** Anthropic: tool calls are `tool_use` blocks; results go back as `tool_result` blocks in a user turn. */
const toAnthropic = (msgs: ToolLoopMessage[]) => {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of msgs) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    } else if ("toolCalls" in m) {
      out.push({
        role: "assistant",
        content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments }))],
      });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
};

/** Anthropic Messages API. */
export class AnthropicClient implements LLMClient, ToolCallingLLM {
  private readonly baseUrl: string;
  private readonly model: (tier?: string) => string;
  private readonly apiKey?: string;
  private readonly f: Fetch;
  constructor(o: { baseUrl: string; model: (tier?: string) => string; apiKey?: string; fetch?: Fetch }) {
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.model = o.model;
    this.apiKey = o.apiKey;
    this.f = o.fetch ?? fetch;
  }
  private body(req: CompletionRequest) {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    return { model: this.model(req.tier), max_tokens: 8192, system: req.json ? `${system}\n\nRespond with JSON only.` : system, messages };
  }
  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey ?? "", "anthropic-version": "2023-06-01" };
  }
  async complete(req: CompletionRequest): Promise<string> {
    const r = await postJson(this.f, `${this.baseUrl}/v1/messages`, this.headers(), this.body(req));
    return ((r.content as { type: string; text?: string }[]) ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  async completeWithTools(req: { messages: ToolLoopMessage[]; tools: ToolSchema[]; tier?: string }) {
    const system = req.messages.filter((m) => m.role === "system").map((m) => ("content" in m ? m.content : "")).join("\n\n");
    const r = await postJson(this.f, `${this.baseUrl}/v1/messages`, this.headers(), {
      model: this.model(req.tier),
      max_tokens: 8192,
      system,
      messages: toAnthropic(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    });
    const content = (r.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) ?? [];
    return {
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("") || undefined,
      toolCalls: content.filter((c) => c.type === "tool_use").map((c) => ({ id: c.id!, name: c.name!, arguments: c.input ?? {} })),
    };
  }
}

const tierModel = (p: ModelProvider) => (tier?: string) =>
  p.spec.models[tier ?? ""] ?? p.spec.models.default ?? Object.values(p.spec.models)[0];

export const openAICompatibleFactory = (f?: Fetch): LLMClientFactory => ({
  create: (p, apiKey) => new OpenAICompatibleClient({ baseUrl: p.spec.baseUrl ?? "https://api.openai.com/v1", model: tierModel(p), apiKey, fetch: f }),
});

export const anthropicFactory = (f?: Fetch): LLMClientFactory => ({
  create: (p, apiKey) => new AnthropicClient({ baseUrl: p.spec.baseUrl ?? "https://api.anthropic.com", model: tierModel(p), apiKey, fetch: f }),
});
