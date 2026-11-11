import type { Agent, AgentRun, Artifact, Clarification, Repository, Skill, WorkItem } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";
import { nsOf } from "../model/meta.ts";
import type {
  ContextProvider,
  ExecutionContext,
  ExecutionContextFactory,
  ModelResolver,
  ResourceReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

export interface ContextFactoryDeps {
  reader: ResourceReader;
  providers: ContextProvider[];
  models: ModelResolver;
  recorders: TranscriptRecorderFactory;
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
    const agent = await resolveRef<Agent>(reader, "Agent", run.spec.agentRef, ns);
    if (!agent) throw new Error(`agent "${run.spec.agentRef.name}" not found`);
    const workItem = await reader.get<WorkItem>("WorkItem", ns, run.spec.workItemRef.name);
    if (!workItem) throw new Error(`work item "${run.spec.workItemRef.name}" not found`);

    const skillRefs = run.spec.skillRefs.length ? run.spec.skillRefs : agent.spec.skillRefs ?? [];
    const skills = await this.skillsWithRequires(skillRefs, ns);

    const owned = { kind: "WorkItem", name: workItem.metadata.name, namespace: ns };
    const allArtifacts = await reader.list<Artifact>("Artifact", { namespace: ns, ownedBy: owned });
    const inputs = run.spec.inputs
      .map((t) => allArtifacts.filter((a) => a.spec.artifactTypeRef.name === t.name).at(-1))
      .filter((a): a is Artifact => !!a);

    const clarifications = (await reader.list<Clarification>("Clarification", { namespace: ns, ownedBy: owned })).filter(
      (c) => c.spec.answers?.length,
    );

    const repositories: Repository[] = [];
    for (const r of workItem.spec.repositoryRefs ?? []) {
      const repo = await resolveRef<Repository>(reader, "Repository", r, ns);
      if (repo) repositories.push(repo);
    }

    const model = await this.d.models.resolve({
      namespace: ns,
      tier: run.spec.modelTier ?? agent.spec.model?.tier ?? "reasoning",
      providerRef: agent.spec.model?.providerRef,
    });

    const ctx: ExecutionContext = {
      run,
      agent,
      skills,
      workItem,
      inputs,
      clarifications,
      repositories,
      sections: [],
      transcript: await this.d.recorders.forRun(run),
      model,
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
