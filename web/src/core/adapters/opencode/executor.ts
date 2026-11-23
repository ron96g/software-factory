/**
 * ADR-0060: runs any model-backed AgentRun in the embedded OpenCode host, with the same factory semantics as the
 * tool loop (shared via run-harness): tool selection, guarded mutations, ToolServers, in-loop `finish` validation,
 * step budget and wrap-up, `source-code` diffs.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SANDBOX_CAPABILITIES,
  canConfineShell,
  type AgentBaselineRequests,
  type AgentCheckLogReader,
  type AgentCheckRequests,
  type AgentExecutor,
  type AgentResult,
  type AgentTool,
  type AgentToolOffering,
  type BoundTool,
  type ExecutionContext,
  type ExecutionEnvironmentSelector,
  type EgressProxy,
  type FinishValidator,
  type KnowledgeSearcher,
  type Lookup,
  type PromptBuilder,
  type ResourceReader,
  type Sandbox,
  type ShellConfiner,
  type ToolCapabilities,
  type ToolProvider,
  type ToolSession,
  type WorkspaceJobCoordinator,
  type WorkspaceMutationGuard,
  type WorkspaceReaderFactory,
} from "../../ports/index.ts";
import { promptHash } from "../../agents/prompt-builder.ts";
import { scopedSearcher } from "../../knowledge/context.ts";
import {
  CITATION_GUIDE, CONTINUE_PROMPT, DEFAULT_MAX_FINISH_CORRECTIONS, DEFAULT_MAX_STEPS, FINISH, FINISH_GUIDE,
  budgetGuide, finishRejection, finishResult, guardedMutation, mcpGuide, mutates, neededCapabilities, openToolServers,
  resolveSandboxProfile, selectTools, validateFinish, workspaceGuide, bindEgress,
} from "../../agents/run-harness.ts";
import { decideIsolation, weakerIsolationNote, type IsolationDecision } from "../../agents/sandbox-isolation.ts";
import { ALWAYS, BUILTIN_EQUIVALENTS, DENY_ALL, PARENT_ONLY, PROTECTED, PROVIDER_PACKAGES, allowTool, type PermissionRule } from "./mapping.ts";
import type { OpenCodeHost } from "./host.ts";

export interface OpenCodeExecutorDeps {
  host: OpenCodeHost;
  reader: ResourceReader;
  prompts: PromptBuilder;
  tools: Lookup<AgentTool>;
  environments: ExecutionEnvironmentSelector;
  readers: WorkspaceReaderFactory;
  /** Directory for runs without a workspace (an empty, per-run working directory). */
  scratchDir: string;
  knowledge?: KnowledgeSearcher;
  toolProvider?: ToolProvider;
  /** ADR-0080 §7: the egress proxy backing `fetch_url`. */
  egress?: EgressProxy;
  checks?: AgentCheckRequests;
  checkLogs?: AgentCheckLogReader;
  baseline?: AgentBaselineRequests;
  finish?: FinishValidator;
  offerings?: AgentToolOffering[];
  mutations?: WorkspaceMutationGuard;
  jobs?: WorkspaceJobCoordinator;
  maxSteps?: number;
  maxFinishCorrections?: number;
}

const SYSTEM = { type: "system" as const, id: "opencode" };
/** OpenCode loads no project configuration (ADR-0060 §2), so the repository's agent instructions are added here. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTIONS = 20_000;

const BUILTIN_GUIDE: Readonly<Record<string, string>> = {
  read: "`read`, `glob`, `grep`: read, find and search files in the workspace",
  edit: "`edit`, `write`: change files precisely (never inside `.git`)",
  shell: "`shell`: run commands in the workspace (build, test, git); commands see no factory secrets",
  skill: "`skill`: load one of the repository's skills when it matches the task",
  subagent: "`subagent`: delegate a focused, independent sub-task to a background sub-agent; it inherits your permissions and reports back",
  execute: "`execute`: run JavaScript in Code Mode to batch, filter and compose factory/MCP tools from `tools.*`",
  webfetch: "`webfetch`: fetch a documentation or reference URL as markdown, text or HTML",
  websearch: "`websearch`: search the web for documentation or current information",
};

export class OpenCodeExecutor implements AgentExecutor {
  readonly name = "opencode";
  private readonly d: OpenCodeExecutorDeps;
  constructor(d: OpenCodeExecutorDeps) {
    this.d = d;
  }

  private needsSandbox(ctx: ExecutionContext): boolean {
    const caps = neededCapabilities(ctx, this.d.tools);
    return SANDBOX_CAPABILITIES.some((c) => caps.has(c));
  }

  canExecute(ctx: ExecutionContext): boolean {
    const tools = ctx.agent.spec.tools ?? [];
    const endpoint = ctx.model?.endpoint;
    if (!endpoint || !PROVIDER_PACKAGES[endpoint.type]) return false;
    if (tools.includes(FINISH.name) || !tools.every((t) => !!this.d.tools.get(t))) return false;
    if (!this.needsSandbox(ctx)) return true;
    // ADR-0060 §4, ADR-0079 §3: OpenCode writes and executes on a runtime that can confine its shell (process-level
    // isolation, e.g. `bwrap`); container/microvm runtimes keep the tool loop until a workspace driver bridges into
    // the sandbox (ADR-0080 §10 removed the unsandboxed `host` runtime).
    return !!ctx.agent.spec.sandboxRef && !!ctx.sandbox?.available
      && ctx.sandbox.confinesShell === true
      && this.readyWorkspaces(ctx).length > 0;
  }

  private readyWorkspaces(ctx: ExecutionContext) {
    return ctx.workspaces.filter((w) => w.status?.phase === "Ready" && w.status.path);
  }

  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const model = ctx.model!;
    const workspaces = this.readyWorkspaces(ctx);
    const reader = workspaces.length ? this.d.readers.forWorkspaces(ctx.workspaces) : undefined;
    let sandbox: Sandbox | undefined;
    let env: Record<string, string> = {};
    let confineShell: ShellConfiner["confineShell"] | undefined;
    let isolation: IsolationDecision | undefined;
    if (this.needsSandbox(ctx)) {
      const { profile, fromRepository } = await resolveSandboxProfile(ctx, this.d.reader);
      const { environment, health } = await this.d.environments.select();
      if (!canConfineShell(environment)) {
        throw new Error(`the OpenCode runtime writes only on shell-confining runtimes (ADR-0060, ADR-0079), selected "${health.runtime}"`);
      }
      isolation = decideIsolation(health, profile);
      if (isolation.acceptedWeaker) {
        await ctx.transcript.record({ role: "note", author: SYSTEM, content: weakerIsolationNote(health, isolation) });
      }
      sandbox = await environment.prepare({ run: ctx.run, profile, repositories: ctx.repositories, workspaces: ctx.workspaces });
      env = { ...(profile.spec.env ?? {}) };
      if (canConfineShell(environment)) confineShell = (input) => environment.confineShell(input);
      await ctx.transcript.record({ role: "note", author: SYSTEM, content: `sandbox ${sandbox.id} prepared (${health.runtime}, profile ${profile.metadata.name}${fromRepository ? " from the repository" : " from the agent"})` });
    } else if (workspaces.length) {
      await ctx.transcript.record({ role: "note", author: SYSTEM, content: `read-only workspace access: ${workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 10)}`).join(", ")}` });
    }
    let toolSession: ToolSession | undefined;
    try {
      const all: ToolCapabilities = {
        read: sandbox ?? reader, search: reader, write: sandbox, exec: sandbox, artifacts: sandbox,
        knowledge: this.d.knowledge ? scopedSearcher(this.d.knowledge, ctx) : undefined,
        egress: bindEgress(ctx, this.d.egress),
        ...(this.d.checks ? { checks: { run: (input) => this.d.checks!.run(ctx, input) } } : {}),
        ...(this.d.checkLogs ? { checkLogs: { read: (input) => this.d.checkLogs!.read(ctx, input) } } : {}),
        ...(this.d.baseline ? { baseline: { run: (input) => this.d.baseline!.runBaseline(ctx, input) } } : {}),
      };
      const selected = await selectTools(ctx, this.d.tools, this.d.offerings, all);
      if (selected.unavailable.length) {
        await ctx.transcript.record({ role: "note", author: SYSTEM, content: `tools not available in this run (missing capability): ${selected.unavailable.join(", ")}` });
      }
      const builtins = new Set<string>(ALWAYS.tools);
      // A sub-agent inherits the run's permissions: without read access it could do nothing useful.
      const canRead = selected.usable.some((tool) => BUILTIN_EQUIVALENTS[tool.name]?.tools.includes("read"));
      if (!canRead) builtins.delete("subagent");
      const mutating = new Set<string>();
      const rules: PermissionRule[] = [DENY_ALL, ...ALWAYS.rules.filter((rule) => builtins.has(rule.action))];
      const factoryTools = new Map<string, BoundTool>();
      const factoryGuidance: string[] = [];
      for (const tool of selected.usable) {
        const group = BUILTIN_EQUIVALENTS[tool.name];
        if (group) {
          for (const t of group.tools) builtins.add(t);
          if (group.mutating) for (const t of group.tools) mutating.add(t);
          rules.push(...group.rules);
          continue;
        }
        // ISP: a tool receives only the capabilities it declares.
        const caps: ToolCapabilities = Object.fromEntries((tool.capabilities ?? []).map((c) => [c, all[c]]));
        const instance = tool.bind!(caps);
        factoryTools.set(tool.name, mutates(tool) ? { ...instance, invoke: (args) => guardedMutation(ctx, this.d, () => instance.invoke(args)) } : instance);
        factoryGuidance.push(`- \`${tool.name}\`: ${tool.guidance ?? tool.description}`);
      }
      // ADR-0034; diagnostic runs cannot rely on external tool servers to enforce candidate immutability (ADR-0059).
      toolSession = ctx.run.spec.recovery?.mode === "diagnosis" ? undefined : await openToolServers(ctx, this.d);
      const external: string[] = [];
      const shadowed: string[] = [];
      for (const t of toolSession?.tools ?? []) {
        if (factoryTools.has(t.schema.name) || builtins.has(t.schema.name)) shadowed.push(t.schema.name);
        else {
          factoryTools.set(t.schema.name, t);
          external.push(t.schema.name);
        }
      }
      if (shadowed.length) await ctx.transcript.record({ role: "note", author: SYSTEM, content: `MCP tools hidden by built-in tools of the same name: ${shadowed.join(", ")}` });
      rules.push(...[...factoryTools.keys(), FINISH.name].map(allowTool), ...PROTECTED);

      const maxSteps = this.d.maxSteps ?? DEFAULT_MAX_STEPS;
      const reads = !!all.read || !!all.search;
      const guide = [
        "## Tools for this run",
        ...workspaceGuide(ctx),
        ...Object.entries(BUILTIN_GUIDE).filter(([name]) => builtins.has(name)).map(([, text]) => `- ${text}`),
        ...factoryGuidance,
        ...mcpGuide(external),
        FINISH_GUIDE,
        "Questions for humans go into `finish` (`questions`); there is no interactive question tool.",
        budgetGuide(maxSteps),
        ...(reads && workspaces.length ? CITATION_GUIDE : []),
      ].join("\n");
      const base = this.d.prompts.build(ctx, "tools");
      const instructions = await this.repositoryInstructions(workspaces);
      const prompt = { system: [base.system, ...instructions, guide].join("\n\n"), user: base.user };
      await ctx.transcript.record({ role: "system", author: SYSTEM, content: prompt.system });
      await ctx.transcript.record({ role: "user", author: SYSTEM, content: prompt.user });

      const diff = sandbox ? () => sandbox!.diff() : async () => "";
      const maxCorrections = this.d.maxFinishCorrections ?? DEFAULT_MAX_FINISH_CORRECTIONS;
      let corrections = 0;
      let lastFinish: AgentResult | undefined;
      let accepted: AgentResult | undefined;
      const hash = promptHash(prompt);
      const directory = await this.directoryFor(ctx, workspaces);
      const childTools = new Set([...builtins].filter((t) => !PARENT_ONLY.has(t)));

      const outcome = await this.d.host.run({
        title: `${ctx.agent.metadata.name} · ${ctx.run.metadata.name}`,
        agent: ctx.agent.metadata.name,
        directory,
        providerName: model.provider,
        endpoint: model.endpoint!,
        model: model.model,
        system: prompt.system,
        prompt: prompt.user,
        rules,
        tools: new Set([...builtins, ...factoryTools.keys(), FINISH.name]),
        childTools,
        mutating,
        factoryTools,
        guard: (operation) => guardedMutation(ctx, this.d, operation),
        env,
        confineShell,
        maxSteps,
        continuePrompt: CONTINUE_PROMPT,
        transcript: ctx.transcript,
        metadata: { agentRun: ctx.run.metadata.name, namespace: ctx.run.metadata.namespace ?? "", agent: ctx.agent.metadata.name },
        onFinish: async (args, { step, calls }) => {
          const final = step >= maxSteps;
          const result = await finishResult(ctx, args, diff, {
            model, promptHash: hash, steps: step, params: { runtime: this.d.host.runtime },
            toolUse: { steps: step, calls, finishCorrections: corrections, ...(final ? { wrapUp: true } : {}) },
          });
          // Once the corrections are used up, the post-run output checks decide (ADR-0049/0055).
          const problems = corrections < maxCorrections ? await validateFinish(ctx, this.d.finish, result, "opencode") : [];
          if (!problems.length) {
            accepted = result;
            return { accepted: true, content: "Result accepted. The run is complete: stop now." };
          }
          lastFinish = result;
          corrections++;
          return { accepted: false, content: finishRejection(problems, corrections, maxCorrections) };
        },
      });
      const result = accepted ?? lastFinish;
      // A rejected finish on the last step still goes to the post-run checks (ADR-0057 §4).
      if (!result) throw new Error(`OpenCode run did not finish within ${maxSteps} steps (${outcome.steps} model steps)`);
      const provenance = {
        ...result.provenance,
        ...(isolation ? { isolation } : {}),
        ...(toolSession?.hostExecution.length ? { hostExecution: toolSession.hostExecution } : {}),
      };
      return { ...result, provenance };
    } catch (e) {
      await ctx.transcript.record({ role: "note", author: SYSTEM, content: `OpenCode run failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    } finally {
      await toolSession?.close();
      if (sandbox) {
        try {
          await sandbox.dispose();
          await ctx.transcript.record({ role: "note", author: SYSTEM, content: `sandbox ${sandbox.id} disposed` });
        } catch (e) {
          await ctx.transcript.record({ role: "note", author: SYSTEM, content: `sandbox ${sandbox.id} dispose failed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
  }

  private async repositoryInstructions(workspaces: ReturnType<OpenCodeExecutor["readyWorkspaces"]>): Promise<string[]> {
    const out: string[] = [];
    for (const ws of workspaces) {
      for (const file of INSTRUCTION_FILES) {
        const text = await readFile(join(ws.status!.path!, file), "utf8").catch(() => undefined);
        if (text === undefined) continue;
        const clipped = text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}\n[truncated]` : text;
        out.push(`## Repository instructions (${ws.spec.repositoryRef.name}/${file})\n${clipped}`);
        break;
      }
    }
    return out;
  }

  /** One workspace: its checkout. Several: the work item's directory holding them (ADR-0021 layout). None: scratch. */
  private async directoryFor(ctx: ExecutionContext, workspaces: ReturnType<OpenCodeExecutor["readyWorkspaces"]>): Promise<string> {
    if (workspaces.length === 1) return workspaces[0].status!.path!;
    if (workspaces.length > 1) return dirname(workspaces[0].status!.path!);
    const dir = join(this.d.scratchDir, ctx.run.metadata.namespace ?? "default", ctx.run.metadata.name);
    await mkdir(dir, { recursive: true });
    return dir;
  }
}
