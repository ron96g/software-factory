import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import type { ClusterApi, ClusterKindRef, RawCustomResource, Unsubscribe } from "../../ports/index.ts";

/** ADR-0071: cluster-wide list/watch of definition CRs (read-only ClusterRole). */
export class KubeClusterApi implements ClusterApi {
  private readonly api: CustomObjectsApi;
  private readonly watcher: Watch;
  constructor(kc?: KubeConfig) {
    const cfg = kc ?? new KubeConfig();
    if (!kc) cfg.loadFromDefault();
    this.api = cfg.makeApiClient(CustomObjectsApi);
    this.watcher = new Watch(cfg);
  }

  async list(ref: ClusterKindRef) {
    const r = (await this.api.listClusterCustomObject({ group: ref.group, version: ref.version, plural: ref.plural })) as {
      items?: RawCustomResource[];
      metadata?: { resourceVersion?: string };
    };
    return { items: r.items ?? [], resourceVersion: r.metadata?.resourceVersion ?? "0" };
  }

  watch(ref: ClusterKindRef, since: string, onEvent: () => void, onClose: (err?: Error) => void): Unsubscribe {
    let aborter: AbortController | undefined;
    let stopped = false;
    this.watcher
      .watch(
        `/apis/${ref.group}/${ref.version}/${ref.plural}`,
        { resourceVersion: since || undefined, allowWatchBookmarks: true },
        (phase) => { if (phase !== "BOOKMARK") onEvent(); },
        (err) => { if (!stopped) onClose(err ?? undefined); },
      )
      .then((a) => { aborter = a; if (stopped) a.abort(); })
      .catch((e) => { if (!stopped) onClose(e instanceof Error ? e : new Error(String(e))); });
    return () => { stopped = true; aborter?.abort(); };
  }
}
