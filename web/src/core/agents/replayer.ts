import type { AgentRun } from "../model/kinds.ts";
import { API_VERSION } from "../model/resource.ts";
import { nsOf } from "../model/meta.ts";
import type { ResourceReader, ResourceWriter, RunReplayer } from "../ports/index.ts";

export const LABEL_REPLAY = "factory.ai-dlc.io/replay";

/**
 * ADR-0012 replay ("re-run" mode): a new AgentRun with the same spec, labelled as a replay.
 * The WorkItem controller only follows deterministic run names, so replays never advance the workflow.
 * Context assembly pins the original run's inputs and clarifications (see DefaultContextFactory).
 */
export class DefaultRunReplayer implements RunReplayer {
  private readonly reader: ResourceReader;
  private readonly writer: ResourceWriter;
  constructor(reader: ResourceReader, writer: ResourceWriter) {
    this.reader = reader;
    this.writer = writer;
  }

  async rerun(original: AgentRun, overrides?: { modelTier?: string }): Promise<AgentRun> {
    if (original.spec.replayOf) throw new Error("re-run the original run, not a replay");
    const ns = nsOf(original);
    const existing = await this.reader.list<AgentRun>("AgentRun", { namespace: ns, labelSelector: { [LABEL_REPLAY]: original.metadata.name } });
    return this.writer.create<AgentRun>({
      apiVersion: API_VERSION,
      kind: "AgentRun",
      metadata: {
        name: `${original.metadata.name}-replay-${existing.length + 1}`,
        namespace: ns,
        ownerReferences: original.metadata.ownerReferences,
        labels: { ...original.metadata.labels, [LABEL_REPLAY]: original.metadata.name },
      },
      spec: { ...original.spec, modelTier: overrides?.modelTier ?? original.spec.modelTier, replayOf: { name: original.metadata.name } },
    });
  }
}
