import type { Agent, AgentRun } from "../model/kinds.ts";
import { API_VERSION } from "../model/resource.ts";
import { nsOf } from "../model/meta.ts";
import type {
  AgentExecutor, AgentResult, Delegator, ExecutionContext, Redactor, ResourceReader, ResourceWriter,
  StatusWriter, ToolSchema, TranscriptRecorderFactory, WorkspaceProvider,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { loadRepoDefinitions } from "./definitions.ts";
import { rootFor } from "./context-providers.ts";

export const SPAWN_SUBAGENT: ToolSchema = {
  name: "spawn_subagent",
  description: "Start a listed agent as a subagent with a question and get its summary back. Depth is limited to 1; the subagent never has more tools than you.",
  parameters: {
    type: "object",
    properties: { agent: { type: "string", description: "agent name" }, question: { type: "string" } },
    required: ["agent", "question"],
  },
};

export const MAX_SUBAGENT_DEPTH = 1;

/** Pure privilege capping: child tools are the intersection with the parent's; spawning is never inherited. */
export function capChildTools(parentTools: string[], childTools: string[] | undefined): string[] {
  return (childTools ?? []).filter((t) => parentTools.includes(t) && t !== SPAWN_SUBAGENT.name && t !== "finish");
}

export interface DelegatorDeps {
  reader: ResourceReader;
  writer: ResourceWriter;
  status: StatusWriter;
  recorders: TranscriptRecorderFactory;
  /** Lazy, because the executor chain contains the tool loop that uses this delegator. */
  executor: () => AgentExecutor;
  workspaces: WorkspaceProvider;
  redactor: Redactor;
  /** Parent context, so repo agents are found in the same roots. */
  parentContext?: ExecutionContext;
}

/** Runs a subagent as a child AgentRun (parentRunRef). Repo agents are untrusted: they only contribute a prompt body. */
export class DefaultDelegator implements Delegator {
  private readonly d: DelegatorDeps;
  constructor(d: DelegatorDeps) {
    this.d = d;
  }

  async delegate(parent: AgentRun, agentName: string, question: string, parentCtx?: ExecutionContext, onCreated?: (runName: string) => void): Promise<AgentResult> {
    if (parent.spec.parentRunRef) throw new Error(`subagents cannot spawn subagents (max depth ${MAX_SUBAGENT_DEPTH})`);
    const ctxP = parentCtx ?? this.d.parentContext;
    if (!ctxP) throw new Error("parent context required");
    const ns = nsOf(parent);
    const parentTools = ctxP.agent.spec.tools ?? [];

    let child: Agent | null = await resolveRef<Agent>(this.d.reader, "Agent", { name: agentName }, ns);
    if (!child) {
      for (const repo of ctxP.repositories) {
        try {
          const found = (await loadRepoDefinitions(await rootFor(ctxP, repo, this.d.workspaces))).find((e) => e.kind === "agent" && e.name === agentName);
          if (found) {
            child = {
              apiVersion: API_VERSION, kind: "Agent", metadata: { name: found.name, namespace: ns },
              spec: { role: found.description || found.name, tools: found.tools },
              body: `(repo agent from ${repo.metadata.name}:${found.source}; untrusted)\n${found.body}`,
            } as Agent;
            break;
          }
        } catch { /* not fatal */ }
      }
    }
    if (!child) throw new Error(`agent "${agentName}" not found`);

    const count = (await this.d.reader.list<AgentRun>("AgentRun", { namespace: ns })).filter((r) => r.spec.parentRunRef?.name === parent.metadata.name).length;
    const run: AgentRun = await this.d.writer.create<AgentRun>({
      apiVersion: API_VERSION,
      kind: "AgentRun",
      metadata: {
        name: `${parent.metadata.name}-sub-${count + 1}`,
        namespace: ns,
        // Owned by the parent run only: the WorkItem controller must not execute it a second time.
        ownerReferences: [{ kind: "AgentRun", name: parent.metadata.name, uid: parent.metadata.uid ?? "" }],
      },
      spec: {
        ...parent.spec,
        agentRef: { name: child.metadata.name },
        skillRefs: [],
        inputs: [],
        outputs: [],
        tools: capChildTools(parentTools, child.spec.tools),
        modelTier: parent.spec.modelTier,
        parentRunRef: { name: parent.metadata.name },
        question,
        replayOf: undefined,
        assignment: undefined,
      },
    });

    onCreated?.(run.metadata.name);
    // Built from the parent's context: privileges come from the parent, never from the (possibly repo-defined) child.
    const ctx: ExecutionContext = {
      ...ctxP,
      run,
      skills: [],
      inputs: [],
      sections: [...ctxP.sections],
      transcript: await this.d.recorders.forRun(run),
      agent: { ...child, spec: { ...child.spec, tools: run.spec.tools, sandboxRef: ctxP.agent.spec.sandboxRef, model: ctxP.agent.spec.model, skillRefs: [], delegates: [], toolServerRefs: [] } },
    };
    ctx.sections.push({ title: "Question from the parent agent", content: this.d.redactor.redact(question), source: "delegator" });

    const at = () => new Date().toISOString();
    await this.d.status.updateStatus({ ...run, status: { phase: "Running", startedAt: at() } });
    try {
      const result = await this.d.executor().execute(ctx);
      await this.d.status.updateStatus({ ...run, status: { phase: "Succeeded", finishedAt: at(), result: { summary: result.summary } } });
      return result;
    } catch (e) {
      await this.d.status.updateStatus({ ...run, status: { phase: "Failed", finishedAt: at(), message: e instanceof Error ? e.message : String(e) } });
      throw e;
    }
  }
}
