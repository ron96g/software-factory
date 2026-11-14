import type { FactoryEvent } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";
import { OUTPUT_REJECTED, type ContextProvider, type Redactor, type ResourceReader } from "../ports/index.ts";

/** ADR-0049: a rerun after rejected output sees exactly why its previous attempt was rejected. */
export function outputFeedbackContext(d: { reader: ResourceReader; redactor: Redactor }): ContextProvider {
  return {
    name: "output-feedback",
    appliesTo: (ctx) => (ctx.workItem.status?.round ?? 0) > 1,
    async provide(ctx) {
      const previous = `${ctx.run.spec.stage}/${ctx.run.spec.step} r${(ctx.workItem.status?.round ?? 0) - 1}:`;
      const events = await d.reader.list<FactoryEvent>("Event", { namespace: nsOf(ctx.workItem), labelSelector: { [LABEL_WORKITEM]: ctx.workItem.metadata.name } });
      const rejected = events.filter((e) => e.spec.reason === OUTPUT_REJECTED && e.spec.involvedObject.uid === ctx.workItem.metadata.uid &&
        e.spec.message.startsWith(previous)).at(-1);
      if (!rejected) return [];
      return [{ title: "Your previous attempt's output was rejected", source: "output-feedback",
        content: d.redactor.redact(`${rejected.spec.message.slice(previous.length).trim()}\n\nProduce the same artifact again with this fixed. Keep everything else that was correct.`) }];
    },
  };
}
