import type { Workflow } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";
import type { CompiledStage, CompiledWorkflow, ResourceReader, WorkflowCompiler } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

/**
 * Flattens phases → stages and inlines `workflowRef` sub-workflows.
 * MVP simplification (AGENTS.md §4): `forEach` runs the sub-workflow once, inline.
 */
export class DefaultWorkflowCompiler implements WorkflowCompiler {
  private readonly reader: ResourceReader;
  constructor(reader: ResourceReader) {
    this.reader = reader;
  }

  async compile(ref: Ref, namespace: string): Promise<CompiledWorkflow> {
    const versions: Record<string, string> = {};
    const stages = await this.stagesOf(ref, namespace, undefined, [], versions);
    const root = await resolveRef<Workflow>(this.reader, "Workflow", ref, namespace);
    const names = new Set<string>();
    for (const s of stages) {
      if (names.has(s.name)) throw new Error(`workflow ${ref.name}: duplicate stage name "${s.name}"`);
      names.add(s.name);
    }
    return {
      name: ref.name,
      versions,
      verification: root?.spec.verification,
      stages,
      stage: (n) => stages.find((s) => s.name === n),
      next: (n) => stages[stages.findIndex((s) => s.name === n) + 1],
    };
  }

  private async stagesOf(ref: Ref, namespace: string, phaseOverride: string | undefined, seen: string[], versions: Record<string, string>): Promise<CompiledStage[]> {
    if (seen.includes(ref.name)) throw new Error(`workflow cycle: ${[...seen, ref.name].join(" → ")}`);
    const wf = await resolveRef<Workflow>(this.reader, "Workflow", ref, namespace);
    if (!wf) throw new Error(`workflow "${ref.name}" not found`);
    versions[`${wf.metadata.namespace}/${wf.metadata.name}`] = wf.metadata.resourceVersion ?? "";
    const out: CompiledStage[] = [];
    for (const phase of wf.spec.phases) {
      for (const st of phase.stages) {
        if (st.workflowRef) {
          out.push(...(await this.stagesOf(st.workflowRef, namespace, phaseOverride ?? phase.name, [...seen, ref.name], versions)));
          continue;
        }
        out.push({
          name: st.name,
          lifecyclePhase: phaseOverride ?? phase.name,
          origin: wf.metadata.name,
          originNamespace: wf.metadata.namespace,
          mode: st.mode,
          publish: st.publish,
          loop: st.loop,
          steps: st.steps ?? [],
          gate: st.gate,
        });
      }
    }
    return out;
  }
}
