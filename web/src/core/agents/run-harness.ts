/**
 * Factory semantics shared by every agent runtime (tool loop, OpenCode; ADR-0060): which tools a run may use,
 * the `finish` protocol and its in-loop validation (ADR-0057), the step budget (ADR-0058), guarded workspace
 * mutations and the agent's ToolServers (ADR-0034).
 */
import type { SandboxProfile, ToolServer, Workflow } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  AgentResult,
  AgentTool,
  AgentToolOffering,
  ExecutionContext,
  ExecutionEnvironmentSelector,
  FinishValidator,
  Lookup,
  ResourceReader,
  ToolCapabilities,
  ToolProvider,
  ToolSchema,
  ToolSession,
  WorkspaceJobCoordinator,
  WorkspaceMutationGuard,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { parseKnowledge, parseQuestions } from "./executors.ts";

export const FINISH: ToolSchema = {
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

/** Steps before the end at which the agent is told to wrap up (ADR-0058). */
export const WRAP_UP_WARNING = 3;
export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_MAX_FINISH_CORRECTIONS = 2;
export const MCP_SEPARATOR = "__";

export const wrapUpWarning = (left: number) =>
  `[harness] ${left} model step(s) left; the last one only allows finish. Wrap up now: complete or stop the current change and call finish.`;
export const lastStepNotice = (maxSteps: number) =>
  `[harness] Last model step (budget ${maxSteps}). Only finish is available: report what you completed and list anything unfinished or unverified in the summary.`;
export const CONTINUE_PROMPT = "Continue using the tools, or call `finish` when you are done.";

export const FINISH_GUIDE = "- `finish`: report your result. It is checked before the run ends; problems come back as the tool result so you can correct them.";
export const budgetGuide = (maxSteps: number) =>
  `Step budget: ${maxSteps} model steps. You are warned ${WRAP_UP_WARNING} steps before the end; the last step only allows \`finish\`. Avoid open-ended investigation outside your task.`;
export const CITATION_GUIDE = [
  "",
  "Before you finish, check the claims you rely on: first against any \"Cited code\" excerpts in your input, then with the read tools.",
  "Cite what you checked as repo:path:line. Code at the pinned commit takes precedence over earlier artifacts.",
];

export const finishRejection = (problems: string[], correction: number, max: number) =>
  `finish rejected (correction ${correction} of ${max}). Fix these problems and call finish again with the complete result; keep everything that was already correct.\n- ${problems.join("\n- ")}`;

const allowedByRun = (ctx: ExecutionContext, name: string) => ctx.run.spec.tools === undefined || ctx.run.spec.tools.includes(name);
const allowedInDiagnosis = (ctx: ExecutionContext, tool: AgentTool | undefined, name: string) =>
  ctx.run.spec.recovery?.mode !== "diagnosis" || !!tool?.readOnly || name === "run_check" || name === "run_baseline_check";

/** Capabilities the run's tools need, after step restrictions and recovery diagnosis (ADR-0059). */
export function neededCapabilities(ctx: ExecutionContext, tools: Lookup<AgentTool>): Set<keyof ToolCapabilities> {
  return new Set((ctx.agent.spec.tools ?? [])
    .filter((name) => allowedByRun(ctx, name))
    .filter((name) => ctx.run.spec.recovery?.mode !== "diagnosis" || tools.get(name)?.readOnly || name === "run_check")
    .flatMap((t) => [...(tools.get(t)?.capabilities ?? [])]));
}

export interface SelectedTools {
  /** Callable tools the run may use whose capabilities are available. */
  usable: AgentTool[];
  /** Tools skipped because a capability is missing in this run (recorded, not an error). */
  unavailable: string[];
}

/**
 * Agent tools plus harness-offered tools, narrowed by the step's `tools` and recovery diagnosis. Throws when the
 * harness offers a tool that is not a registered callable tool.
 */
export async function selectTools(ctx: ExecutionContext, tools: Lookup<AgentTool>, offerings: AgentToolOffering[] | undefined, caps: ToolCapabilities): Promise<SelectedTools> {
  const offered = (await Promise.all((offerings ?? []).map((offering) => offering.tools(ctx)))).flat().filter((name) => allowedByRun(ctx, name));
  const usable: AgentTool[] = [];
  const unavailable: string[] = [];
  for (const name of new Set([...(ctx.agent.spec.tools ?? []), ...offered])) {
    if (!allowedByRun(ctx, name)) continue;
    const tool = tools.get(name);
    if (!tool?.bind) throw new Error(`harness offered an unregistered callable tool "${name}"`);
    if (!allowedInDiagnosis(ctx, tool, name)) continue;
    if ((tool.capabilities ?? []).some((c) => !caps[c])) {
      unavailable.push(name);
      continue;
    }
    usable.push(tool);
  }
  return { usable, unavailable };
}

/** Write/exec tools change the workspace and must be guarded and serialized. */
export const mutates = (tool: AgentTool) => !tool.readOnly && (tool.capabilities ?? []).some((cap) => cap === "write" || cap === "exec");

export interface MutationDeps {
  reader: ResourceReader;
  mutations?: WorkspaceMutationGuard;
  jobs?: WorkspaceJobCoordinator;
}

/** Runs a workspace mutation behind the mutation guard, serialized with workspace jobs (ADR-0042/0059). */
export async function guardedMutation<T>(ctx: ExecutionContext, d: MutationDeps, operation: () => Promise<T>): Promise<T> {
  const invoke = async () => {
    await d.mutations?.check(ctx);
    return operation();
  };
  if (d.jobs) return d.jobs.mutate(ctx, invoke);
  if (ctx.run.spec.recovery) throw new Error("recovery workspace mutation requires shared workspace serialization");
  if (ctx.workItem?.spec?.workflowRef) {
    const workflow = await resolveRef<Workflow>(d.reader, "Workflow", ctx.workItem.spec.workflowRef, nsOf(ctx.workItem));
    if (!workflow || workflow.spec.recovery) throw new Error("workspace mutation requires shared workspace serialization for recovery workflows");
  }
  return invoke();
}

/** ADR-0033: the repository knows its toolchain (e.g. Go), so its profile wins over the agent's default. */
export async function resolveSandboxProfile(ctx: ExecutionContext, reader: ResourceReader): Promise<{ profile: SandboxProfile; fromRepository: boolean }> {
  const repoRef = ctx.repositories.find((r) => r.spec.sandboxRef && ctx.workspaces.some((w) => w.spec.repositoryRef.name === r.metadata.name))?.spec.sandboxRef;
  const profileRef = repoRef ?? ctx.agent.spec.sandboxRef!;
  const profile = await resolveRef<SandboxProfile>(reader, "SandboxProfile", profileRef, nsOf(ctx.agent));
  if (!profile) throw new Error(`sandbox profile "${profileRef.name}" not found`);
  return { profile, fromRepository: !!repoRef };
}

/** ADR-0034: opens the agent's ToolServers for one run; the caller closes the session. */
export async function openToolServers(ctx: ExecutionContext, d: { reader: ResourceReader; toolProvider?: ToolProvider; environments: ExecutionEnvironmentSelector }): Promise<ToolSession | undefined> {
  const refs = ctx.agent.spec.toolServerRefs ?? [];
  if (!refs.length || !d.toolProvider) return undefined;
  const sys = { type: "system" as const, id: "tool-servers" };
  const servers: ToolServer[] = [];
  for (const ref of refs) {
    const s = await resolveRef<ToolServer>(d.reader, "ToolServer", ref, nsOf(ctx.agent));
    if (s) servers.push(s);
    else await ctx.transcript.record({ role: "note", author: sys, content: `tool server "${ref.name}" not found` });
  }
  const allowStdio = (await d.environments.select()).health.runtime === "host";
  const session = await d.toolProvider.open(servers, { allowStdio, runName: ctx.run.metadata.name });
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

/** Groups external tool names by server for the tool guide (only names: their descriptions are untrusted). */
export function mcpGuide(names: string[]): string[] {
  const servers = new Map<string, string[]>();
  for (const name of names) {
    const server = name.includes(MCP_SEPARATOR) ? name.slice(0, name.indexOf(MCP_SEPARATOR)) : "external";
    servers.set(server, [...(servers.get(server) ?? []), name]);
  }
  return [...servers].map(([server, list]) => `- MCP server ${server} (external; see each tool's own description): ${list.map((n) => `\`${n}\``).join(", ")}`);
}

export function workspaceGuide(ctx: ExecutionContext): string[] {
  const workspaces = ctx.workspaces.filter((w) => w.status?.phase === "Ready");
  return workspaces.length ? [`Workspaces (pinned commits): ${workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 10) ?? "?"}`).join(", ")}.`] : [];
}

export interface FinishMeta {
  model: NonNullable<ExecutionContext["model"]>;
  promptHash: string;
  steps: number;
  toolUse: NonNullable<AgentResult["provenance"]>["toolUse"];
  params?: Record<string, unknown>;
}

/** Turns `finish` arguments into the run's result; `source-code` outputs get the workspace diff. */
export async function finishResult(ctx: ExecutionContext, args: Record<string, unknown>, diff: () => Promise<string>, meta: FinishMeta): Promise<AgentResult> {
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
      model: { provider: meta.model.provider, name: meta.model.model, tier: meta.model.tier, params: { steps: meta.steps, ...meta.params } },
      promptHash: meta.promptHash,
      toolUse: meta.toolUse,
    },
  };
}

/** Never fails the run on a validator error: the post-run checks still apply. */
export async function validateFinish(ctx: ExecutionContext, finish: FinishValidator | undefined, result: AgentResult, component: string): Promise<string[]> {
  if (!finish) return [];
  try {
    return await finish.validate(ctx, result);
  } catch (e) {
    await ctx.transcript.record({ role: "note", author: { type: "system", id: component }, content: `finish validation skipped: ${e instanceof Error ? e.message : String(e)}` });
    return [];
  }
}
