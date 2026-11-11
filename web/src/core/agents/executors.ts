import type {
  AgentExecutor,
  AgentResult,
  AgentTool,
  ExecutionContext,
  Lookup,
  PromptBuilder,
  SkillHandlerLookup,
} from "../ports/index.ts";
import { promptHash } from "./prompt-builder.ts";

const agentAuthor = (ctx: ExecutionContext) => ({ type: "agent" as const, id: ctx.agent.metadata.name });

/** Chain of Responsibility (ADR-0006): first executor that can handle the context wins. */
export class ExecutorChain implements AgentExecutor {
  readonly name = "chain";
  private readonly executors: AgentExecutor[];
  constructor(executors: AgentExecutor[]) {
    this.executors = executors;
  }
  canExecute(ctx: ExecutionContext): boolean {
    return this.executors.some((e) => e.canExecute(ctx));
  }
  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const e = this.executors.find((x) => x.canExecute(ctx));
    if (!e) throw new Error("no executor can handle this run");
    await ctx.transcript.record({ role: "note", author: { type: "system", id: "executor-chain" }, content: `executor: ${e.name}` });
    const r = await e.execute(ctx);
    return { ...r, provenance: { executor: e.name, ...r.provenance } };
  }
}

/**
 * LLM executor (JSON mode). Only for agents whose tools are all context-provided read-only tools;
 * agents with sandbox tools use the SandboxToolLoopExecutor or fall through to simulation (ADR-0019).
 */
export class LLMExecutor implements AgentExecutor {
  readonly name = "llm";
  private readonly prompts: PromptBuilder;
  private readonly tools: Lookup<AgentTool>;
  constructor(prompts: PromptBuilder, tools: Lookup<AgentTool>) {
    this.prompts = prompts;
    this.tools = tools;
  }
  canExecute(ctx: ExecutionContext): boolean {
    // JSON mode fallback: read-only tools are optional here (context providers supply code hits instead);
    // agents that need write/exec tools must use the tool loop with a sandbox (ADR-0019).
    return !!ctx.model && (ctx.agent.spec.tools ?? []).every((t) => {
      const tool = this.tools.get(t);
      return !!tool && tool.readOnly;
    });
  }
  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const model = ctx.model!;
    const prompt = this.prompts.build(ctx);
    const sys = { type: "system" as const, id: "prompt-builder" };
    await ctx.transcript.record({ role: "system", author: sys, content: prompt.system });
    await ctx.transcript.record({ role: "user", author: sys, content: prompt.user });
    const started = Date.now();
    const text = await model.client.complete({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      tier: model.tier,
      json: true,
    });
    await ctx.transcript.record({
      role: "assistant",
      author: agentAuthor(ctx),
      content: text,
      meta: { latencyMs: Date.now() - started, model: model.model, provider: model.provider },
    });
    const parsed = parseAgentJson(text);
    return {
      ...parsed,
      provenance: {
        model: { provider: model.provider, name: model.model, tier: model.tier },
        promptHash: promptHash(prompt),
      },
    };
  }
}

/** Deterministic implementations of skills (e.g. code research without an LLM). */
export class SkillHandlerExecutor implements AgentExecutor {
  readonly name = "skill-handler";
  private readonly handlers: SkillHandlerLookup;
  constructor(handlers: SkillHandlerLookup) {
    this.handlers = handlers;
  }
  private handlerFor(ctx: ExecutionContext) {
    return ctx.run.spec.skillRefs.map((s) => this.handlers.get(s.name)).find(Boolean);
  }
  canExecute(ctx: ExecutionContext): boolean {
    return !!this.handlerFor(ctx);
  }
  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const h = this.handlerFor(ctx)!;
    await ctx.transcript.record({ role: "note", author: { type: "system", id: "skill-handler" }, content: `deterministic handler for skill "${h.skill}"` });
    const r = await h.handle(ctx);
    await ctx.transcript.record({ role: "assistant", author: agentAuthor(ctx), content: JSON.stringify(r, null, 2) });
    return r;
  }
}

export function parseAgentJson(text: string): AgentResult {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("agent did not return a JSON object");
  const raw = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    artifacts: arr<{ type: string; content: string }>(raw.artifacts).filter((a) => a && typeof a.type === "string"),
    classification: raw.classification && typeof raw.classification === "object" ? (raw.classification as AgentResult["classification"]) : undefined,
    outcome: typeof raw.outcome === "string" ? raw.outcome : undefined,
    questions: arr<string>(raw.questions).filter((q) => typeof q === "string" && q.trim()),
  };
}
