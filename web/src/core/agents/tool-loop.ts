import type { SandboxProfile } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import {
  ISOLATION_RANK,
  canCallTools,
  type AgentExecutor,
  type AgentResult,
  type AgentTool,
  type BoundTool,
  type ExecutionContext,
  type ExecutionEnvironmentSelector,
  type Lookup,
  type PromptBuilder,
  type ResourceReader,
  type ToolCapabilities,
  type WorkspaceReaderFactory,
  type Sandbox,
  SANDBOX_CAPABILITIES,
  type ToolLoopMessage,
  type ToolSchema,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { promptHash } from "./prompt-builder.ts";

const FINISH: ToolSchema = {
  name: "finish",
  description: "Finish the task and report the result. Call exactly once, at the end.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "object", properties: { type: { type: "string" }, content: { type: "string" } }, required: ["type", "content"] } },
      outcome: { type: "string" },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["summary"],
  },
};

export interface ToolLoopDeps {
  reader: ResourceReader;
  prompts: PromptBuilder;
  tools: Lookup<AgentTool>;
  environments: ExecutionEnvironmentSelector;
  readers: WorkspaceReaderFactory;
  maxSteps?: number;
}

/**
 * Agentic tool loop (ADR-0019/0021). Every model turn, tool call and tool result is recorded (rule 14).
 * Capabilities are assembled from what the agent's tools declare:
 *  - only `read`/`search` → the item's workspace, read-only, no sandbox needed (analysis agents);
 *  - any of `write`/`exec`/`artifacts` → a sandbox (needs sandboxRef + an available runtime).
 */
export class ToolLoopExecutor implements AgentExecutor {
  readonly name = "tool-loop";
  private readonly d: ToolLoopDeps;
  constructor(d: ToolLoopDeps) {
    this.d = d;
  }

  private neededCapabilities(ctx: ExecutionContext): Set<keyof ToolCapabilities> {
    return new Set((ctx.agent.spec.tools ?? []).flatMap((t) => [...(this.d.tools.get(t)?.capabilities ?? [])]));
  }

  private needsSandbox(ctx: ExecutionContext): boolean {
    const caps = this.neededCapabilities(ctx);
    return SANDBOX_CAPABILITIES.some((c) => caps.has(c));
  }

  canExecute(ctx: ExecutionContext): boolean {
    const tools = ctx.agent.spec.tools ?? [];
    const base =
      !!ctx.model &&
      canCallTools(ctx.model.client) &&
      tools.length > 0 &&
      !tools.includes(FINISH.name) && // reserved protocol tool
      tools.every((t) => !!this.d.tools.get(t)?.bind);
    if (!base) return false;
    return this.needsSandbox(ctx) ? !!ctx.agent.spec.sandboxRef && !!ctx.sandbox?.available : ctx.workspaces.length > 0;
  }

  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const model = ctx.model!;
    if (!canCallTools(model.client)) throw new Error("model does not support tool calling");
    const sys = { type: "system" as const, id: "tool-loop" };
    const agentAuthor = { type: "agent" as const, id: ctx.agent.metadata.name };
    const reader = ctx.workspaces.length ? this.d.readers.forWorkspaces(ctx.workspaces) : undefined;

    if (!this.needsSandbox(ctx)) {
      const prompt = this.d.prompts.build(ctx, "tools");
      await ctx.transcript.record({ role: "system", author: sys, content: prompt.system });
      await ctx.transcript.record({ role: "user", author: sys, content: prompt.user });
      await ctx.transcript.record({ role: "note", author: sys, content: `read-only workspace access: ${ctx.workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 10)}`).join(", ")}` });
      return this.loop(ctx, prompt, { read: reader, search: reader }, async () => "");
    }

    const profile = await resolveRef<SandboxProfile>(this.d.reader, "SandboxProfile", ctx.agent.spec.sandboxRef!, nsOf(ctx.agent));
    if (!profile) throw new Error(`sandbox profile "${ctx.agent.spec.sandboxRef!.name}" not found`);
    const { environment, health } = await this.d.environments.select();
    const required = profile.spec.isolation ?? "container";
    const insufficient = ISOLATION_RANK[health.isolation] < ISOLATION_RANK[required];
    if (insufficient && !health.waivesIsolation) {
      throw new Error(`sandbox runtime "${health.runtime}" provides isolation "${health.isolation}", profile requires "${required}"`);
    }

    const prompt = this.d.prompts.build(ctx, "tools");
    await ctx.transcript.record({ role: "system", author: sys, content: prompt.system });
    await ctx.transcript.record({ role: "user", author: sys, content: prompt.user });

    if (insufficient) {
      await ctx.transcript.record({
        role: "note",
        author: sys,
        content: `WARNING: runtime "${health.runtime}" is unsandboxed (isolation ${health.isolation}); profile minimum "${required}" waived by explicit opt-in (ADR-0020).`,
      });
    }
    const sandbox: Sandbox = await environment.prepare({ run: ctx.run, profile, repositories: ctx.repositories, workspaces: ctx.workspaces });
    await ctx.transcript.record({ role: "note", author: sys, content: `sandbox ${sandbox.id} prepared (${health.runtime}, profile ${profile.metadata.name})` });
    try {
      return await this.loop(ctx, prompt, { read: sandbox, write: sandbox, exec: sandbox, artifacts: sandbox, search: reader }, () => sandbox.diff());
    } catch (e) {
      await ctx.transcript.record({ role: "note", author: sys, content: `tool loop failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    } finally {
      try {
        await sandbox.dispose();
        await ctx.transcript.record({ role: "note", author: sys, content: `sandbox ${sandbox.id} disposed` });
      } catch (e) {
        // never mask the original error; the cleanup controller removes orphans
        await ctx.transcript.record({ role: "note", author: sys, content: `sandbox ${sandbox.id} dispose failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  private async loop(
    ctx: ExecutionContext,
    prompt: { system: string; user: string },
    all: ToolCapabilities,
    diff: () => Promise<string>,
  ): Promise<AgentResult> {
    const model = ctx.model!;
    if (!canCallTools(model.client)) throw new Error("model does not support tool calling");
    const sys = { type: "system" as const, id: "tool-loop" };
    const agentAuthor = { type: "agent" as const, id: ctx.agent.metadata.name };
    {
      const bound = new Map<string, BoundTool>();
      const unavailable: string[] = [];
      for (const name of ctx.agent.spec.tools ?? []) {
        const tool = this.d.tools.get(name)!;
        if ((tool.capabilities ?? []).some((c) => !all[c])) {
          unavailable.push(name); // e.g. search_code without a workspace: offered tools shrink, nothing fails
          continue;
        }
        // ISP: a tool receives only the capabilities it declares.
        const caps: ToolCapabilities = Object.fromEntries((tool.capabilities ?? []).map((c) => [c, all[c]]));
        bound.set(name, tool.bind!(caps));
      }
      if (unavailable.length) {
        await ctx.transcript.record({ role: "note", author: sys, content: `tools not available in this run (missing capability): ${unavailable.join(", ")}` });
      }
      const schemas = [...[...bound.values()].map((b) => b.schema), FINISH];
      const messages: ToolLoopMessage[] = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];
      const maxSteps = this.d.maxSteps ?? 30;

      for (let step = 1; step <= maxSteps; step++) {
        const started = Date.now();
        const reply = await model.client.completeWithTools({ messages, tools: schemas, tier: model.tier });
        await ctx.transcript.record({
          role: "assistant",
          author: agentAuthor,
          content: reply.text ?? (reply.toolCalls.length ? "" : "(empty)"),
          meta: { step, latencyMs: Date.now() - started, model: model.model, toolCalls: reply.toolCalls.map((c) => c.name) },
        });
        if (!reply.toolCalls.length) {
          messages.push({ role: "assistant", content: reply.text ?? "" });
          messages.push({ role: "user", content: "Continue using the tools, or call `finish` when you are done." });
          continue;
        }
        messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
          await ctx.transcript.record({ role: "tool-call", author: agentAuthor, content: JSON.stringify(call.arguments), meta: { tool: call.name, step } });
          if (call.name === "finish") {
            return await this.finish(ctx, call.arguments, diff, { model, promptHash: promptHash(prompt), steps: step });
          }
          let result: string;
          const tool = bound.get(call.name);
          try {
            result = tool ? await tool.invoke(call.arguments) : `error: unknown tool "${call.name}"`;
          } catch (e) {
            result = `error: ${e instanceof Error ? e.message : String(e)}`;
          }
          await ctx.transcript.record({ role: "tool-result", author: sys, content: result, meta: { tool: call.name, step } });
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
        }
      }
      throw new Error(`tool loop did not finish within ${maxSteps} steps`);
    }
  }

  private async finish(
    ctx: ExecutionContext,
    args: Record<string, unknown>,
    diff: () => Promise<string>,
    meta: { model: NonNullable<ExecutionContext["model"]>; promptHash: string; steps: number },
  ): Promise<AgentResult> {
    const artifacts = (Array.isArray(args.artifacts) ? args.artifacts : [])
      .filter((a): a is { type: string; content: string } => !!a && typeof a.type === "string")
      .map((a) => ({ type: a.type, content: String(a.content ?? "") }));
    if (ctx.run.spec.outputs.some((o) => o.name === "source-code")) {
      const d = await diff();
      const existing = artifacts.find((a) => a.type === "source-code");
      const body = `${existing?.content ?? `# Changes\n\n${String(args.summary ?? "")}`}\n\n## Diff\n\n\`\`\`diff\n${d || "(no changes)"}\n\`\`\``;
      if (existing) existing.content = body;
      else artifacts.push({ type: "source-code", content: body });
    }
    return {
      summary: typeof args.summary === "string" ? args.summary : undefined,
      artifacts,
      outcome: typeof args.outcome === "string" ? args.outcome : undefined,
      questions: Array.isArray(args.questions) ? args.questions.filter((q): q is string => typeof q === "string" && !!q.trim()) : [],
      provenance: {
        model: { provider: meta.model.provider, name: meta.model.model, tier: meta.model.tier, params: { steps: meta.steps } },
        promptHash: meta.promptHash,
      },
    };
  }
}
