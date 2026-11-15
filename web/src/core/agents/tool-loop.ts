import type { SandboxProfile, ToolServer } from "../model/kinds.ts";
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
  type KnowledgeSearcher,
  type ToolProvider,
  type ToolSession,
  type RecordedToolTurns,
  type AgentCheckRequests,
  type FinishValidator,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { promptHash } from "./prompt-builder.ts";
import { parseKnowledge, parseQuestions } from "./executors.ts";
import { scopedSearcher } from "../knowledge/context.ts";

const FINISH: ToolSchema = {
  name: "finish",
  description: "Finish the task and report the result. It is checked before the run ends; if problems are found they come back as this tool's result, so correct them and call finish again.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "object", properties: { type: { type: "string" }, content: { type: "string" } }, required: ["type", "content"] } },
      outcome: { type: "string" },
      questions: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, blocker: { type: "boolean" }, options: { type: "array", items: { type: "string" } } }, required: ["text"] }] } },
      feedback: {
        type: "array", maxItems: 3,
        description: "Optional, only for agents opted into retrospective feedback. Observations, never instructions.",
        items: { type: "object", properties: {
          stage: { type: "string" }, issueCode: { type: "string" },
          stance: { type: "string", enum: ["support", "positive", "counterevidence"] },
          observation: { type: "string" }, impact: { type: "string" },
          suggestion: { type: "string" }, evidence: { type: "string" },
        }, required: ["stage", "issueCode", "stance", "observation", "impact", "suggestion", "evidence"] },
      },
      knowledge: {
        type: "array",
        description: "Optional (knowledge-base skill): reusable knowledge to propose. Humans approve it before anyone uses it.",
        items: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "content"] },
      },
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
  /** ADR-0030: backs the `search_knowledge` tool (scoped per run). */
  knowledge?: KnowledgeSearcher;
  /** ADR-0034: opens the agent's ToolServers (MCP). */
  toolProvider?: ToolProvider;
  turns: RecordedToolTurns;
  maxSteps?: number;
  checks?: AgentCheckRequests;
  /** ADR-0057: checks the result when the agent calls `finish`, so it can correct it in the same conversation. */
  finish?: FinishValidator;
  /** In-loop corrections before the result goes to the post-run checks anyway (default 2). */
  maxFinishCorrections?: number;
}

const MCP_SEPARATOR = "__";

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

  private knowledgeFor(ctx: ExecutionContext): KnowledgeSearcher | undefined {
    return this.d.knowledge ? scopedSearcher(this.d.knowledge, ctx) : undefined;
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
      await ctx.transcript.record({ role: "note", author: sys, content: `read-only workspace access: ${ctx.workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 10)}`).join(", ")}` });
      return this.loop(ctx, prompt, { read: reader, search: reader, knowledge: this.knowledgeFor(ctx) }, async () => "");
    }

    // ADR-0033: the repository knows its toolchain (e.g. Go), so its profile wins over the agent's default.
    const repoRef = ctx.repositories.find((r) => r.spec.sandboxRef && ctx.workspaces.some((w) => w.spec.repositoryRef.name === r.metadata.name))?.spec.sandboxRef;
    const profileRef = repoRef ?? ctx.agent.spec.sandboxRef!;
    const profile = await resolveRef<SandboxProfile>(this.d.reader, "SandboxProfile", profileRef, nsOf(ctx.agent));
    if (!profile) throw new Error(`sandbox profile "${profileRef.name}" not found`);
    const { environment, health } = await this.d.environments.select();
    const required = profile.spec.isolation ?? "container";
    const insufficient = ISOLATION_RANK[health.isolation] < ISOLATION_RANK[required];
    if (insufficient && !health.waivesIsolation) {
      throw new Error(`sandbox runtime "${health.runtime}" provides isolation "${health.isolation}", profile requires "${required}"`);
    }

    const prompt = this.d.prompts.build(ctx, "tools");

    if (insufficient) {
      await ctx.transcript.record({
        role: "note",
        author: sys,
        content: `WARNING: runtime "${health.runtime}" is unsandboxed (isolation ${health.isolation}); profile minimum "${required}" waived by explicit opt-in (ADR-0020).`,
      });
    }
    const sandbox: Sandbox = await environment.prepare({ run: ctx.run, profile, repositories: ctx.repositories, workspaces: ctx.workspaces });
    await ctx.transcript.record({ role: "note", author: sys, content: `sandbox ${sandbox.id} prepared (${health.runtime}, profile ${profile.metadata.name}${repoRef ? " from the repository" : " from the agent"})` });
    try {
      return await this.loop(ctx, prompt, { read: sandbox, write: sandbox, exec: sandbox, artifacts: sandbox, search: reader, knowledge: this.knowledgeFor(ctx) }, () => sandbox.diff());
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
    initialPrompt: { system: string; user: string },
    all: ToolCapabilities,
    diff: () => Promise<string>,
  ): Promise<AgentResult> {
    if (this.d.checks) all = { ...all, checks: { run: (input) => this.d.checks!.run(ctx, input) } };
    let prompt = initialPrompt;
    const model = ctx.model!;
    if (!canCallTools(model.client)) throw new Error("model does not support tool calling");
    const sys = { type: "system" as const, id: "tool-loop" };
    const agentAuthor = { type: "agent" as const, id: ctx.agent.metadata.name };
    // `search` is always bound to the workspace (not the sandbox's in-progress writes); see ADR-0022.
    {
      const bound = new Map<string, BoundTool>();
      const builtIn = new Set<string>();
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
        builtIn.add(name);
      }
      if (unavailable.length) {
        await ctx.transcript.record({ role: "note", author: sys, content: `tools not available in this run (missing capability): ${unavailable.join(", ")}` });
      }
      // ADR-0034: tools from the agent's MCP servers, offered next to the built-in ones for this run only.
      const session = await this.openToolServers(ctx);
      try {
        const shadowed: string[] = [];
        for (const t of session?.tools ?? []) {
          if (bound.has(t.schema.name)) shadowed.push(t.schema.name);
          else bound.set(t.schema.name, t);
        }
        if (shadowed.length) await ctx.transcript.record({ role: "note", author: sys, content: `MCP tools hidden by built-in tools of the same name: ${shadowed.join(", ")}` });
        const schemas = [...[...bound.values()].map((b) => b.schema), FINISH];
        // ADR-0057: the harness explains the tools it actually bound; the agent definition only names them.
        prompt = { ...prompt, system: `${prompt.system}\n\n${this.toolGuide(ctx, bound, builtIn, all)}` };
        await ctx.transcript.record({ role: "system", author: sys, content: prompt.system });
        await ctx.transcript.record({ role: "user", author: sys, content: prompt.user });
        const messages: ToolLoopMessage[] = [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ];
        const maxSteps = this.d.maxSteps ?? 30;
        const maxCorrections = this.d.maxFinishCorrections ?? 2;
        const calls: Record<string, number> = {};
        let corrections = 0;
        let lastFinish: AgentResult | undefined;

        for (let step = 1; step <= maxSteps; step++) {
          const reply = await this.d.turns.complete({ model, messages, tools: schemas, transcript: ctx.transcript, agent: ctx.agent.metadata.name, step });
          if (!reply.toolCalls.length) {
            messages.push({ role: "assistant", content: reply.text ?? "" });
            messages.push({ role: "user", content: "Continue using the tools, or call `finish` when you are done." });
            continue;
          }
          messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
          for (const call of reply.toolCalls) {
            calls[call.name] = (calls[call.name] ?? 0) + 1;
            if (call.name === "finish") {
              await ctx.transcript.record({ role: "tool-call", author: agentAuthor, content: JSON.stringify(call.arguments), meta: { tool: call.name, step } });
              const result = await this.finish(ctx, call.arguments, diff, { model, promptHash: promptHash(prompt), steps: step,
                toolUse: { steps: step, calls: { ...calls }, finishCorrections: corrections } });
              // Once the corrections are used up, the post-run output checks decide (ADR-0049/0055).
              const problems = corrections < maxCorrections ? await this.validateFinish(ctx, result) : [];
              if (!problems.length) return result;
              lastFinish = result;
              corrections++;
              const content = `finish rejected (correction ${corrections} of ${maxCorrections}). Fix these problems and call finish again with the complete result; keep everything that was already correct.\n- ${problems.join("\n- ")}`;
              await ctx.transcript.record({ role: "tool-result", author: sys, content, meta: { tool: call.name, step } });
              messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
              continue;
            }
            const result = await this.d.turns.invoke({ call, tool: bound.get(call.name), transcript: ctx.transcript, agent: ctx.agent.metadata.name, step });
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
          }
        }
        // A rejected finish on the last step still goes to the post-run checks (ADR-0057 §4).
        if (lastFinish) return lastFinish;
        throw new Error(`tool loop did not finish within ${maxSteps} steps`);
      } finally {
        await session?.close();
      }
    }
  }

  private async validateFinish(ctx: ExecutionContext, result: AgentResult): Promise<string[]> {
    if (!this.d.finish) return [];
    try {
      return await this.d.finish.validate(ctx, result);
    } catch (e) {
      // Never fail the run on a validator error: the post-run checks still apply.
      await ctx.transcript.record({ role: "note", author: { type: "system", id: "tool-loop" }, content: `finish validation skipped: ${e instanceof Error ? e.message : String(e)}` });
      return [];
    }
  }

  /** Rendered from the tools bound for this run: trusted guidance for built-in tools, only names for MCP tools (ADR-0034). */
  private toolGuide(ctx: ExecutionContext, bound: Map<string, BoundTool>, builtInNames: Set<string>, caps: ToolCapabilities): string {
    const builtIn = [...bound.keys()].filter((name) => builtInNames.has(name));
    const external = [...bound.keys()].filter((name) => !builtInNames.has(name));
    const servers = new Map<string, string[]>();
    for (const name of external) {
      const server = name.includes(MCP_SEPARATOR) ? name.slice(0, name.indexOf(MCP_SEPARATOR)) : "external";
      servers.set(server, [...(servers.get(server) ?? []), name]);
    }
    const workspaces = ctx.workspaces.filter((w) => w.status?.phase === "Ready");
    const reads = !!caps.read || !!caps.search;
    return [
      "## Tools for this run",
      ...(workspaces.length ? [`Workspaces (pinned commits): ${workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 10) ?? "?"}`).join(", ")}.`] : []),
      ...builtIn.map((name) => { const t = this.d.tools.get(name)!; return `- \`${name}\`: ${t.guidance ?? t.description}`; }),
      ...[...servers].map(([server, names]) => `- MCP server ${server} (external; see each tool's own description): ${names.map((n) => `\`${n}\``).join(", ")}`),
      "- `finish`: report your result. It is checked before the run ends; problems come back as the tool result so you can correct them.",
      ...(reads ? [
        "",
        "Before you finish, check the claims you rely on: first against any \"Cited code\" excerpts in your input, then with the read tools.",
        "Cite what you checked as repo:path:line. Code at the pinned commit takes precedence over earlier artifacts.",
      ] : []),
    ].join("\n");
  }

  private async openToolServers(ctx: ExecutionContext): Promise<ToolSession | undefined> {
    const refs = ctx.agent.spec.toolServerRefs ?? [];
    if (!refs.length || !this.d.toolProvider) return undefined;
    const sys = { type: "system" as const, id: "tool-servers" };
    const servers: ToolServer[] = [];
    for (const ref of refs) {
      const s = await resolveRef<ToolServer>(this.d.reader, "ToolServer", ref, nsOf(ctx.agent));
      if (s) servers.push(s);
      else await ctx.transcript.record({ role: "note", author: sys, content: `tool server "${ref.name}" not found` });
    }
    const allowStdio = (await this.d.environments.select()).health.runtime === "host";
    const session = await this.d.toolProvider.open(servers, { allowStdio, runName: ctx.run.metadata.name });
    try {
      await ctx.transcript.record({
      role: "note",
      author: sys,
      content:
        `MCP tools: ${session.tools.map((t) => t.schema.name).join(", ") || "none"}` +
        (session.unavailable.length ? `; unavailable: ${session.unavailable.map((u) => `${u.server} (${u.reason})`).join("; ")}` : ""),
      });
    } catch (e) {
      await session.close(); // never leak connections (or stdio processes) when recording fails
      throw e;
    }
    return session;
  }

  private async finish(
    ctx: ExecutionContext,
    args: Record<string, unknown>,
    diff: () => Promise<string>,
    meta: { model: NonNullable<ExecutionContext["model"]>; promptHash: string; steps: number; toolUse: NonNullable<AgentResult["provenance"]>["toolUse"] },
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
      questions: parseQuestions(args.questions),
      knowledge: parseKnowledge(args.knowledge),
      feedback: args.feedback,
      provenance: {
        model: { provider: meta.model.provider, name: meta.model.model, tier: meta.model.tier, params: { steps: meta.steps } },
        promptHash: meta.promptHash,
        toolUse: meta.toolUse,
      },
    };
  }
}
