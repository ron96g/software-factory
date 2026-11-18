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
  type KnowledgeSearcher,
  type ToolProvider,
  type RecordedToolTurns,
  type AgentCheckRequests,
  type AgentCheckLogReader,
  type AgentBaselineRequests,
  type FinishValidator,
  type AgentToolOffering,
  type WorkspaceMutationGuard,
  type WorkspaceJobCoordinator,
} from "../ports/index.ts";
import { promptHash } from "./prompt-builder.ts";
import { scopedSearcher } from "../knowledge/context.ts";
import {
  CITATION_GUIDE, CONTINUE_PROMPT, DEFAULT_MAX_FINISH_CORRECTIONS, DEFAULT_MAX_STEPS, FINISH, FINISH_GUIDE, WRAP_UP_WARNING,
  budgetGuide, finishRejection, finishResult, guardedMutation, lastStepNotice, mcpGuide, mutates, neededCapabilities,
  openToolServers, resolveSandboxProfile, selectTools, validateFinish, workspaceGuide, wrapUpWarning,
} from "./run-harness.ts";

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
  checkLogs?: AgentCheckLogReader;
  baseline?: AgentBaselineRequests;
  /** ADR-0057: checks the result when the agent calls `finish`, so it can correct it in the same conversation. */
  finish?: FinishValidator;
  /** In-loop corrections before the result goes to the post-run checks anyway (default 2). */
  maxFinishCorrections?: number;
  offerings?: AgentToolOffering[];
  mutations?: WorkspaceMutationGuard;
  jobs?: WorkspaceJobCoordinator;
}


/** Adds a harness notice to what the model reads next, without breaking tool-call/result pairing. */
function notice(messages: ToolLoopMessage[], text: string) {
  const last = messages.at(-1);
  if (last && (last.role === "tool" || last.role === "user")) last.content = `${last.content}\n\n${text}`;
  else messages.push({ role: "user", content: text });
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

  private knowledgeFor(ctx: ExecutionContext): KnowledgeSearcher | undefined {
    return this.d.knowledge ? scopedSearcher(this.d.knowledge, ctx) : undefined;
  }

  private needsSandbox(ctx: ExecutionContext): boolean {
    const caps = neededCapabilities(ctx, this.d.tools);
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

    const { profile, fromRepository } = await resolveSandboxProfile(ctx, this.d.reader);
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
    await ctx.transcript.record({ role: "note", author: sys, content: `sandbox ${sandbox.id} prepared (${health.runtime}, profile ${profile.metadata.name}${fromRepository ? " from the repository" : " from the agent"})` });
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
    if (this.d.checkLogs) all = { ...all, checkLogs: { read: (input) => this.d.checkLogs!.read(ctx, input) } };
    if (this.d.baseline) all = { ...all, baseline: { run: (input) => this.d.baseline!.runBaseline(ctx, input) } };
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
      const selected = await selectTools(ctx, this.d.tools, this.d.offerings, all);
      unavailable.push(...selected.unavailable); // e.g. search_code without a workspace: offered tools shrink, nothing fails
      for (const tool of selected.usable) {
        // ISP: a tool receives only the capabilities it declares.
        const caps: ToolCapabilities = Object.fromEntries((tool.capabilities ?? []).map((c) => [c, all[c]]));
        const instance = tool.bind!(caps);
        bound.set(tool.name, mutates(tool)
          ? { ...instance, invoke: (args) => guardedMutation(ctx, this.d, () => instance.invoke(args)) }
          : instance);
        builtIn.add(tool.name);
      }
      if (unavailable.length) {
        await ctx.transcript.record({ role: "note", author: sys, content: `tools not available in this run (missing capability): ${unavailable.join(", ")}` });
      }
      // ADR-0034: tools from the agent's MCP servers, offered next to the built-in ones for this run only.
      // Diagnostic runs cannot rely on external tool servers to enforce candidate immutability.
      const session = ctx.run.spec.recovery?.mode === "diagnosis" ? undefined : await openToolServers(ctx, this.d);
      try {
        const shadowed: string[] = [];
        for (const t of session?.tools ?? []) {
          if (bound.has(t.schema.name)) shadowed.push(t.schema.name);
          else bound.set(t.schema.name, t);
        }
        if (shadowed.length) await ctx.transcript.record({ role: "note", author: sys, content: `MCP tools hidden by built-in tools of the same name: ${shadowed.join(", ")}` });
        const schemas = [...[...bound.values()].map((b) => b.schema), FINISH];
        // ADR-0057: the harness explains the tools it actually bound; the agent definition only names them.
        const maxSteps = this.d.maxSteps ?? DEFAULT_MAX_STEPS;
        prompt = { ...prompt, system: `${prompt.system}\n\n${this.toolGuide(ctx, bound, builtIn, all, maxSteps)}` };
        await ctx.transcript.record({ role: "system", author: sys, content: prompt.system });
        await ctx.transcript.record({ role: "user", author: sys, content: prompt.user });
        const messages: ToolLoopMessage[] = [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ];
        const maxCorrections = this.d.maxFinishCorrections ?? DEFAULT_MAX_FINISH_CORRECTIONS;
        const calls: Record<string, number> = {};
        let corrections = 0;
        let lastFinish: AgentResult | undefined;

        const say = async (text: string, step: number) => {
          notice(messages, text);
          await ctx.transcript.record({ role: "note", author: sys, content: text, meta: { step } });
        };

        for (let step = 1; step <= maxSteps; step++) {
          // ADR-0058: the last step only offers `finish`, so a run out of budget reports instead of losing its result.
          const final = step === maxSteps;
          if (final) {
            await say(lastStepNotice(maxSteps), step);
          }
          const reply = await this.d.turns.complete({ model, messages, tools: final ? [FINISH] : schemas, transcript: ctx.transcript, agent: ctx.agent.metadata.name, step });
          if (!reply.toolCalls.length) {
            messages.push({ role: "assistant", content: reply.text ?? "" });
            messages.push({ role: "user", content: CONTINUE_PROMPT });
            continue;
          }
          messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
          for (const call of reply.toolCalls) {
            calls[call.name] = (calls[call.name] ?? 0) + 1;
            if (call.name === "finish") {
              await ctx.transcript.record({ role: "tool-call", author: agentAuthor, content: JSON.stringify(call.arguments), meta: { tool: call.name, step } });
              const result = await finishResult(ctx, call.arguments, diff, { model, promptHash: promptHash(prompt), steps: step,
                toolUse: { steps: step, calls: { ...calls }, finishCorrections: corrections, ...(final ? { wrapUp: true } : {}) } });
              // Once the corrections are used up, the post-run output checks decide (ADR-0049/0055).
              const problems = corrections < maxCorrections ? await validateFinish(ctx, this.d.finish, result, "tool-loop") : [];
              if (!problems.length) return result;
              lastFinish = result;
              corrections++;
              const content = finishRejection(problems, corrections, maxCorrections);
              await ctx.transcript.record({ role: "tool-result", author: sys, content, meta: { tool: call.name, step } });
              messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
              continue;
            }
            const result = await this.d.turns.invoke({ call, tool: final ? undefined : bound.get(call.name), transcript: ctx.transcript, agent: ctx.agent.metadata.name, step });
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
          }
          const left = maxSteps - step;
          if (left > 0 && left <= WRAP_UP_WARNING) {
            await say(wrapUpWarning(left), step);
          }
        }
        // A rejected finish on the last step still goes to the post-run checks (ADR-0057 §4).
        if (lastFinish) return lastFinish;
        // ADR-0067: one finish-only correction step when the budget ended without any finish call.
        const note = "[harness] The step budget is used up and no finish was received. Call finish now with what is done and what is not.";
        await say(note, maxSteps);
        messages.push({ role: "user", content: note });
        const last = await this.d.turns.complete({ model, messages, tools: [FINISH], transcript: ctx.transcript, agent: ctx.agent.metadata.name, step: maxSteps + 1 });
        const call = last.toolCalls.find((c) => c.name === "finish");
        if (call) {
          await ctx.transcript.record({ role: "tool-call", author: agentAuthor, content: JSON.stringify(call.arguments), meta: { tool: call.name, step: maxSteps + 1 } });
          return finishResult(ctx, call.arguments, diff, { model, promptHash: promptHash(prompt), steps: maxSteps + 1,
            toolUse: { steps: maxSteps + 1, calls: { ...calls }, finishCorrections: corrections, wrapUp: true } });
        }
        throw new Error(`tool loop did not finish within ${maxSteps} steps`);
      } finally {
        await session?.close();
      }
    }
  }



  /** Rendered from the tools bound for this run: trusted guidance for built-in tools, only names for MCP tools (ADR-0034). */
  private toolGuide(ctx: ExecutionContext, bound: Map<string, BoundTool>, builtInNames: Set<string>, caps: ToolCapabilities, maxSteps: number): string {
    const builtIn = [...bound.keys()].filter((name) => builtInNames.has(name));
    const external = [...bound.keys()].filter((name) => !builtInNames.has(name));
    return [
      "## Tools for this run",
      ...workspaceGuide(ctx),
      ...builtIn.map((name) => { const t = this.d.tools.get(name)!; return `- \`${name}\`: ${t.guidance ?? t.description}`; }),
      ...mcpGuide(external),
      FINISH_GUIDE,
      budgetGuide(maxSteps),
      ...(caps.read || caps.search ? CITATION_GUIDE : []),
    ].join("\n");
  }
}
