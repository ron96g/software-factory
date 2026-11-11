import type { ModelProvider } from "../../model/kinds.ts";
import type { CompletionRequest, LLMClient, LLMClientFactory, ToolCall, ToolCallingLLM, ToolSchema } from "../../ports/index.ts";

type Fetch = typeof fetch;

async function postJson(f: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

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
  async completeWithTools(req: CompletionRequest & { tools: ToolSchema[] }) {
    const r = await postJson(this.f, `${this.baseUrl}/chat/completions`, this.headers(), {
      model: this.model(req.tier),
      messages: req.messages,
      tools: req.tools.map((t) => ({ type: "function", function: t })),
    });
    const msg = (r.choices as { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[])[0]
      .message;
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments || "{}") }));
    return { text: msg.content ?? undefined, toolCalls };
  }
}

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
  async completeWithTools(req: CompletionRequest & { tools: ToolSchema[] }) {
    const r = await postJson(this.f, `${this.baseUrl}/v1/messages`, this.headers(), {
      ...this.body(req),
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
