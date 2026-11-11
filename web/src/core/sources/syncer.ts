import type { Source, WorkItem } from "../model/kinds.ts";
import { API_VERSION, DEFAULT_NAMESPACE } from "../model/resource.ts";
import {
  canFetch,
  type EventRecorder,
  type Lookup,
  type ResourceReader,
  type ResourceWriter,
  type SourceConnector,
  type SourceSyncer,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

const LABEL_EXTERNAL_UPDATED = "factory.ai-dlc.io/external-updated-at";

/** Imports ExternalItems as WorkItems (anti-corruption layer: connectors never create WorkItems themselves). */
export class DefaultSourceSyncer implements SourceSyncer {
  private readonly d: { reader: ResourceReader; writer: ResourceWriter; connectors: Lookup<SourceConnector>; events: EventRecorder };
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
    for (const item of items) {
      const name = `${sourceName}-${item.externalId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const existing = await this.d.reader.get<WorkItem>("WorkItem", DEFAULT_NAMESPACE, name);
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
          },
        });
        created++;
      } else if (existing.metadata.annotations?.[LABEL_EXTERNAL_UPDATED] !== (item.updatedAt ?? "")) {
        await this.d.writer.update<WorkItem>({
          ...existing,
          metadata: { ...existing.metadata, annotations: { ...existing.metadata.annotations, [LABEL_EXTERNAL_UPDATED]: item.updatedAt ?? "" } },
          spec: { ...existing.spec, title: item.title, description: item.description },
        });
        updated++;
      }
    }
    await this.d.events.normal(source, "Synced", `${created} created, ${updated} updated`);
    return { created, updated };
  }
}
