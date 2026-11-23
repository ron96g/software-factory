/**
 * ADR-0080 §5 (S2-b): the factory-side implementation of the run tool surface. It binds the run's offering exactly as
 * the in-process loop does (`selectTools` + `AgentTool.bind`, plus the agent's MCP servers), then serves it to a
 * runtime. Tools that touch the workspace are marked *runtime-local* and refused here — they run inside the runtime.
 */
import type {
  AgentTool,
  AgentToolOffering,
  BoundTool,
  ExecutionContext,
  Lookup,
  ToolCapabilities,
  ToolSchema,
  ToolProvider,
  RunToolCall,
  RunToolSurface,
} from "../ports/index.ts";
import { RunToolSurfaceError } from "../ports/index.ts";
import { FINISH, openToolServers, selectTools } from "./run-harness.ts";

/** Capabilities that make a tool touch the workspace; such a tool runs **inside** the runtime, never on the surface. */
const WORKSPACE_CAPS = new Set<keyof ToolCapabilities>(["read", "search", "write", "exec", "artifacts"]);

/** A tool that declares **any** workspace capability runs inside the runtime, never on the factory-side surface. */
export function isRuntimeLocal(tool: AgentTool): boolean {
  return (tool.capabilities ?? []).some((c) => WORKSPACE_CAPS.has(c));
}

export interface RunToolSurfaceHostDeps {
  tools: Lookup<AgentTool>;
  /** Opens the agent's MCP servers (ADR-0034); their tools are factory-side. */
  toolProvider?: ToolProvider;
  /** The factory-side capabilities (checks, knowledge, egress, …). Workspace capabilities are irrelevant here. */
  capabilities(ctx: ExecutionContext): ToolCapabilities;
  offerings?: AgentToolOffering[];
  /** ADR-0057: validates a `finish` call in-loop; `ok` ends the run, otherwise the problems go back to the model. */
  finish?(args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; problems: string[] }>;
}

export class BoundRunToolSurface implements RunToolSurface {
  readonly run: RunToolSurface["run"];
  private readonly bound: Map<string, BoundTool>;
  private readonly local: Set<string>;
  private readonly schemas: ToolSchema[];
  private readonly finish?: RunToolSurfaceHostDeps["finish"];
  private readonly record?: (entry: { name: string; args: Record<string, unknown>; result: string }) => Promise<void>;

  constructor(run: RunToolSurface["run"], bound: Map<string, BoundTool>, local: Set<string>, schemas: ToolSchema[], finish?: RunToolSurfaceHostDeps["finish"],
    record?: (entry: { name: string; args: Record<string, unknown>; result: string }) => Promise<void>) {
    this.run = run;
    this.bound = bound;
    this.local = local;
    this.schemas = schemas;
    this.finish = finish;
    this.record = record;
  }

  async offering(): Promise<ToolSchema[]> {
    return this.schemas;
  }

  async invoke(call: RunToolCall): Promise<{ content: string }> {
    // Rule 14: the factory records every call it serves, authoritatively, regardless of what the runtime reports.
    const content = await this.dispatch(call);
    await this.record?.({ name: call.name, args: call.arguments, result: content });
    return { content };
  }

  private async dispatch(call: RunToolCall): Promise<string> {
    if (call.name === "finish") {
      if (!this.finish) throw new RunToolSurfaceError("finish is not available for this run", 400);
      const r = await this.finish(call.arguments);
      return r.ok ? "ok" : `finish rejected. Fix these problems and call finish again with the complete result:\n- ${r.problems.join("\n- ")}`;
    }
    if (this.local.has(call.name)) throw new RunToolSurfaceError(`"${call.name}" runs inside the runtime, not on the tool surface`, 400);
    const tool = this.bound.get(call.name);
    if (!tool) throw new RunToolSurfaceError(`tool "${call.name}" is not in this run's offering`, 403);
    return await tool.invoke(call.arguments);
  }
}

/** Binds the run's offering for one `ExecutionContext`; the caller closes the returned session when the run ends. */
export async function buildRunToolSurface(
  ctx: ExecutionContext,
  deps: RunToolSurfaceHostDeps & { reader: Parameters<typeof openToolServers>[1]["reader"] },
): Promise<{ surface: BoundRunToolSurface; close: () => Promise<void> }> {
  const caps = deps.capabilities(ctx);
  const selected = await selectTools(ctx, deps.tools, deps.offerings, caps);
  const bound = new Map<string, BoundTool>();
  const local = new Set<string>();
  for (const tool of selected.usable) {
    const instance = tool.bind!(Object.fromEntries((tool.capabilities ?? []).map((c) => [c, caps[c]])) as ToolCapabilities);
    bound.set(tool.name, instance);
    if (isRuntimeLocal(tool)) local.add(tool.name);
  }

  const session = ctx.run.spec.recovery?.mode === "diagnosis" ? undefined : await openToolServers(ctx, { reader: deps.reader, toolProvider: deps.toolProvider });
  try {
    for (const t of session?.tools ?? []) if (!bound.has(t.schema.name)) bound.set(t.schema.name, t);
    const schemas: ToolSchema[] = [...[...bound.values()].map((b) => b.schema), FINISH];
    const record = async ({ name, args, result }: { name: string; args: Record<string, unknown>; result: string }) => {
      await ctx.transcript.record({ role: "tool-call", author: { type: "agent", id: ctx.agent.metadata.name }, content: JSON.stringify({ tool: name, arguments: args }).slice(0, 4000), meta: { tool: name, toolSurface: true } });
      await ctx.transcript.record({ role: "tool-result", author: { type: "system", id: "tool-surface" }, content: result.slice(0, 4000), meta: { tool: name, toolSurface: true } });
    };
    const surface = new BoundRunToolSurface(ctx.run.metadata, bound, local, schemas, deps.finish, record);
    return { surface, close: async () => { await session?.close(); } };
  } catch (e) {
    await session?.close();
    throw e;
  }
}
