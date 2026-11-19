import type { InlineFeedback } from "../model/kinds.ts";
import type { DraftFeedbackBatch, Principal, ResourceReader, ResourceWriter } from "../ports/index.ts";

export class StoreDraftFeedbackBatch implements DraftFeedbackBatch {
  private readonly d: { namespace: string; reader: ResourceReader; writer: ResourceWriter };
  constructor(d: StoreDraftFeedbackBatch["d"]) { this.d = d; }

  async include(p: Principal, workItem: string, stages: string[], batch: string): Promise<string[]> {
    const owned = { kind: "WorkItem", name: workItem, namespace: this.d.namespace };
    const drafts = (await this.d.reader.list<InlineFeedback>("InlineFeedback", { namespace: this.d.namespace, ownedBy: owned }))
      .filter((f) => !f.spec.submitted && stages.includes(f.spec.producedBy.stage));
    const submitted = { id: batch, at: new Date().toISOString(), by: p.id };
    const marked: string[] = [];
    try {
      for (const f of drafts) {
        await this.d.writer.update<InlineFeedback>({ ...f, spec: { ...f.spec, submitted } });
        marked.push(f.metadata.name);
      }
    } catch (e) {
      await this.release(marked, batch).catch(() => undefined);
      throw e;
    }
    return marked;
  }

  async release(names: string[], batch: string): Promise<void> {
    for (const name of names) {
      const f = await this.d.reader.get<InlineFeedback>("InlineFeedback", this.d.namespace, name);
      if (f?.spec.submitted?.id === batch) await this.d.writer.update<InlineFeedback>({ ...f, spec: { ...f.spec, submitted: undefined } });
    }
  }
}
