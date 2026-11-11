import type { Agent, AgentRun, Artifact, Clarification, Repository, Skill, WorkItem, Workspace } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";
import { nsOf } from "../model/meta.ts";
import type {
  ContextProvider,
  ExecutionContext,
  ExecutionContextFactory,
  ExecutionEnvironmentSelector,
  ModelResolver,
  ResourceReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { LABEL_REPLAY } from "./replayer.ts";

export interface ContextFactoryDeps {
  reader: ResourceReader;
  providers: ContextProvider[];
  models: ModelResolver;
  recorders: TranscriptRecorderFactory;
  environments: ExecutionEnvironmentSelector;
}

/** Assembles everything an executor needs: definitions, inputs, human answers, repos, enrichment, model. */
export class DefaultContextFactory implements ExecutionContextFactory {
  private readonly d: ContextFactoryDeps;
  constructor(d: ContextFactoryDeps) {
    this.d = d;
  }

  async create(run: AgentRun): Promise<ExecutionContext> {
    const ns = nsOf(run);
    const { reader } = this.d;
    const found = await resolveRef<Agent>(reader, "Agent", run.spec.agentRef, ns);
    if (!found) throw new Error(`agent "${run.spec.agentRef.name}" not found`);
    // A step may only narrow the agent's tools (intersection), never extend them.
    const agent: Agent = run.spec.tools
      ? { ...found, spec: { ...found.spec, tools: (found.spec.tools ?? []).filter((t) => run.spec.tools!.includes(t)) } }
      : found;
    const workItem = await reader.get<WorkItem>("WorkItem", ns, run.spec.workItemRef.name);
    if (!workItem) throw new Error(`work item "${run.spec.workItemRef.name}" not found`);

    const skillRefs = run.spec.skillRefs.length ? run.spec.skillRefs : agent.spec.skillRefs ?? [];
    const skills = await this.skillsWithRequires(skillRefs, ns);

    const owned = { kind: "WorkItem", name: workItem.metadata.name, namespace: ns };
    // Artifacts produced by replays never become inputs of the real workflow (ADR-0012).
    const allArtifacts = (await reader.list<Artifact>("Artifact", { namespace: ns, ownedBy: owned })).filter(
      (a) => !a.metadata.labels?.[LABEL_REPLAY],
    );
    let clarifications = (await reader.list<Clarification>("Clarification", { namespace: ns, ownedBy: owned })).filter(
      (c) => c.spec.answers?.length,
    );
    let inputs = run.spec.inputs
      .map((t) => allArtifacts.filter((a) => a.spec.artifactTypeRef.name === t.name).at(-1))
      .filter((a): a is Artifact => !!a);

    if (run.spec.replayOf) {
      // Faithful replay: same inputs and human answers as the original run saw.
      const original = await reader.get<AgentRun>("AgentRun", ns, run.spec.replayOf.name);
      const prov = original?.status?.provenance;
      if (prov) {
        inputs = allArtifacts.filter((a) => a.metadata.name in prov.inputs);
        clarifications = clarifications.filter((c) => (prov.clarifications ?? []).includes(c.metadata.name));
      }
    }

    const repositories: Repository[] = [];
    for (const r of workItem.spec.repositoryRefs ?? []) {
      const repo = await resolveRef<Repository>(reader, "Repository", r, ns);
      if (repo) repositories.push(repo);
    }

    const workspaces = (await reader.list<Workspace>("Workspace", { namespace: ns, ownedBy: owned })).filter((w) => w.status?.phase === "Ready");

    const model = await this.d.models.resolve({
      namespace: ns,
      tier: run.spec.modelTier ?? agent.spec.model?.tier ?? "reasoning",
      providerRef: agent.spec.model?.providerRef,
    });

    const sandbox = agent.spec.sandboxRef ? (await this.d.environments.select()).health : undefined;

    const ctx: ExecutionContext = {
      run,
      agent,
      skills,
      workItem,
      inputs,
      clarifications,
      repositories,
      workspaces,
      sections: [],
      transcript: await this.d.recorders.forRun(run),
      model,
      sandbox,
    };
    for (const p of this.d.providers) {
      if (p.appliesTo(ctx)) ctx.sections.push(...(await p.provide(ctx)));
    }
    return ctx;
  }

  private async skillsWithRequires(refs: Ref[], ns: string): Promise<Skill[]> {
    const out = new Map<string, Skill>();
    const visit = async (ref: Ref) => {
      if (out.has(ref.name)) return;
      const s = await resolveRef<Skill>(this.d.reader, "Skill", ref, ns);
      if (!s) throw new Error(`skill "${ref.name}" not found`);
      out.set(ref.name, s);
      for (const r of s.spec.requires ?? []) await visit(r);
    };
    for (const r of refs) await visit(r);
    return [...out.values()];
  }
}
