import type { Source, SourceHistory, WorkItem } from "../model/kinds.ts";
import { API_VERSION, DEFAULT_NAMESPACE } from "../model/resource.ts";
import {
  canFetch,
  canFetchHistory,
  FACTORY_COMMENT_MARKER,
  type Clock,
  type EventRecorder,
  type FollowUpOriginResolver,
  type MirrorLinkChecker,
  type Lookup,
  type ResourceReader,
  type ResourceWriter,
  type SourceConnector,
  type SourceSyncer,
} from "../ports/index.ts";
import { externalRefLabel } from "../issues/mirror.ts";
import { resolveRef } from "../refs/refs.ts";
import { boundHistory } from "./history-bounds.ts";

export const workItemNameFor = (source: string, externalId: string) => `${source}-${externalId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

const LABEL_EXTERNAL_UPDATED = "factory.ai-dlc.io/external-updated-at";

/** Imports ExternalItems as WorkItems (anti-corruption layer: connectors never create WorkItems themselves). */
export class DefaultSourceSyncer implements SourceSyncer {
  private readonly d: { reader: ResourceReader; writer: ResourceWriter; connectors: Lookup<SourceConnector>; events: EventRecorder; clock: Clock; mirrors?: MirrorLinkChecker; origins?: FollowUpOriginResolver };
  /** Last history error per `<source>/<externalId>`: a persistently unreadable ticket warns once, not every poll. */
  private readonly historyErrors = new Map<string, string>();
  constructor(d: DefaultSourceSyncer["d"]) {
    this.d = d;
  }

  async sync(sourceName: string): Promise<{ created: number; updated: number }> {
    const source = await resolveRef<Source>(this.d.reader, "Source", { name: sourceName }, DEFAULT_NAMESPACE);
    if (!source) throw new Error(`source ${sourceName} not found`);
    const connector = this.d.connectors.get(source.spec.type);
    if (!connector) throw new Error(`no connector registered for source type "${source.spec.type}"`);
    if (!canFetch(connector)) throw new Error(`source type "${source.spec.type}" cannot be synced`);

    const items = await connector.fetchItems(source);
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of items) {
      const name = workItemNameFor(sourceName, item.externalId);
      if (await this.d.mirrors?.isUnlinkedMirror(item.description)) { skipped++; continue; }
      let existing = await this.d.reader.get<WorkItem>("WorkItem", DEFAULT_NAMESPACE, name);
      if (!existing) {
        const byLabel = await this.d.reader.list<WorkItem>("WorkItem", { namespace: DEFAULT_NAMESPACE, labelSelector: { "factory.ai-dlc.io/external-ref": externalRefLabel(sourceName, item.externalId) } });
        existing = byLabel[0] ?? null;
      }
      const origin = await this.d.origins?.resolve(item.description);
      const changed = !existing || existing.metadata.annotations?.[LABEL_EXTERNAL_UPDATED] !== (item.updatedAt ?? "") || Boolean(origin && !existing.spec.originWorkItemRef);
      // ADR-0070: where the connector can read the ticket's history, it is mandatory. Without it the item is left
      // as it is (not created, not updated) and the next sync retries; the item's updated stamp isn't advanced.
      let sourceHistory: SourceHistory | undefined;
      if (canFetchHistory(connector) && (changed || !existing?.spec.sourceHistory)) {
        const errorKey = `${sourceName}/${item.externalId}`;
        try {
          const h = await connector.fetchHistory(source, item.externalId);
          sourceHistory = boundHistory({
            ...h,
            fetchedAt: this.d.clock.now().toISOString(),
            comments: h.comments.map((c) => (c.body.includes(FACTORY_COMMENT_MARKER) ? { ...c, byFactory: true } : c)),
          });
          this.historyErrors.delete(errorKey);
        } catch (e) {
          failed++;
          const message = e instanceof Error ? e.message : String(e);
          if (this.historyErrors.get(errorKey) !== message) {
            this.historyErrors.set(errorKey, message);
            await this.d.events.warning(source, "HistoryUnavailable", `${item.externalId}: ticket history could not be read, item not ${existing ? "updated" : "imported"}: ${message}`);
          }
          continue;
        }
      }
      if (!existing) {
        await this.d.writer.create<WorkItem>({
          apiVersion: API_VERSION,
          kind: "WorkItem",
          metadata: { name, namespace: DEFAULT_NAMESPACE, annotations: { [LABEL_EXTERNAL_UPDATED]: item.updatedAt ?? "" } },
          spec: {
            title: item.title,
            description: item.description,
            sourceRef: { name: sourceName },
            externalRef: { id: item.externalId, url: item.url },
            ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
            ...(sourceHistory ? { sourceHistory } : {}),
            ...(origin ?? {}),
          },
        });
        created++;
      } else if (changed || sourceHistory) {
        await this.d.writer.update<WorkItem>({
          ...existing,
          metadata: { ...existing.metadata, annotations: { ...existing.metadata.annotations, [LABEL_EXTERNAL_UPDATED]: item.updatedAt ?? "" } },
          spec: {
            ...existing.spec,
            title: item.title,
            description: item.description,
            // ADR-0094: a new head is recorded, never acted on; the pinned workspace keeps the reviewed commit.
            ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
            ...(sourceHistory ? { sourceHistory } : {}),
            // Repositories are not changed on an existing item: its workspace is already pinned.
            ...(origin && !existing.spec.originWorkItemRef ? { originWorkItemRef: origin.originWorkItemRef, originSnapshot: origin.originSnapshot } : {}),
          },
        });
        updated++;
      }
    }
    await this.d.events.normal(source, "Synced", `${created} created, ${updated} updated${skipped ? `, ${skipped} skipped (mirror not linked yet)` : ""}${failed ? `, ${failed} failed (ticket history unavailable)` : ""}`);
    return { created, updated };
  }
}
