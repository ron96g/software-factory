import type { KnowledgeEntry, KnowledgePhase } from "../../model/kinds.ts";
import { keyOf, parseKey } from "../../model/meta.ts";
import { isStoreError, type Clock, type Controller, type EventRecorder, type InitialKeys, type ResourceReader, type StatusWriter } from "../../ports/index.ts";

export const knowledgePhase = (e: KnowledgeEntry): KnowledgePhase =>
  e.spec.retired ? "Retired" : e.spec.review?.decision === "approve" ? "Approved" : e.spec.review?.decision === "reject" ? "Rejected" : "Proposed";

/** ADR-0030: owns KnowledgeEntry.status. Humans write the review into spec; the phase follows it. */
export function createKnowledgeController(d: { reader: ResourceReader; status: StatusWriter; events: EventRecorder; clock: Clock }): Controller & InitialKeys {
  return {
    name: "knowledge",
    primaryKind: "KnowledgeEntry",
    watches: ["KnowledgeEntry"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    initialKeys: async () => (await d.reader.list<KnowledgeEntry>("KnowledgeEntry")).filter((e) => e.status?.phase !== knowledgePhase(e)).map(keyOf),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const e = await d.reader.get<KnowledgeEntry>("KnowledgeEntry", namespace, name);
      if (!e) return;
      const phase = knowledgePhase(e);
      if (e.status?.phase === phase) return;
      try {
        const updated = await d.status.updateStatus<KnowledgeEntry>({
          ...e,
          status: { phase, approvedAt: phase === "Approved" ? (e.spec.review?.at ?? d.clock.now().toISOString()) : e.status?.approvedAt },
        });
        const by = e.spec.review?.by ? ` by ${e.spec.review.by}` : "";
        const message =
          phase === "Proposed" ? (e.spec.provenance?.agent ? `proposed by ${e.spec.provenance.agent}` : "awaiting review") : `${phase.toLowerCase()}${phase === "Retired" ? "" : by}`;
        await d.events.normal(updated, phase, message);
      } catch (err) {
        if (isStoreError(err, "Conflict")) return { requeueAfterMs: 0 };
        throw err;
      }
    },
  };
}
