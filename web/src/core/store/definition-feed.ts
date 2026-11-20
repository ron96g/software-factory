import type { Unsubscribe, ClusterApi, DefinitionFeed, DefinitionList, DefinitionLoader } from "../ports/index.ts";
import { crdRef, DEFINITION_CRDS, toResource, type NamespaceMap } from "./cr-mapper.ts";

/** Git mode: lists once, never changes. */
export class GitDefinitionFeed implements DefinitionFeed {
  private readonly loader: DefinitionLoader;
  constructor(loader: DefinitionLoader) {
    this.loader = loader;
  }
  async list(): Promise<DefinitionList> {
    return { resources: await this.loader.load(), resourceVersion: "git" };
  }
}

export class KubernetesDefinitionFeed implements DefinitionFeed {
  private readonly api: ClusterApi;
  private readonly namespaces: NamespaceMap;
  constructor(api: ClusterApi, namespaces: NamespaceMap = {}) {
    this.api = api;
    this.namespaces = namespaces;
  }
  async list(): Promise<DefinitionList> {
    const resources = [];
    let rv = "0";
    for (const kind of Object.keys(DEFINITION_CRDS)) {
      const r = await this.api.list(crdRef(kind));
      for (const cr of r.items) resources.push(toResource(kind, cr, this.namespaces));
      if (Number(r.resourceVersion) > Number(rv) || Number.isNaN(Number(rv))) rv = r.resourceVersion;
    }
    return { resources, resourceVersion: rv };
  }

  /** One watch per kind. A drop or 410 asks for a relist (`onChange`) and re-watches after a delay. */
  watch(since: string, onChange: () => void, retryMs = 1000): Unsubscribe {
    let stopped = false;
    const stops = new Set<Unsubscribe>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const start = (kind: string, rv: string) => {
      const stop = this.api.watch!(crdRef(kind), rv, onChange, () => {
        stops.delete(stop);
        if (stopped) return;
        onChange();
        const t = setTimeout(() => { timers.delete(t); if (!stopped) start(kind, ""); }, retryMs);
        timers.add(t);
      });
      stops.add(stop);
    };
    if (this.api.watch) for (const kind of Object.keys(DEFINITION_CRDS)) start(kind, since);
    return () => {
      stopped = true;
      stops.forEach((s) => s());
      timers.forEach(clearTimeout);
    };
  }
}

/** Adapts a feed to the loader the definition store consumes. */
export class FeedDefinitionLoader implements DefinitionLoader {
  private readonly feed: DefinitionFeed;
  constructor(feed: DefinitionFeed) {
    this.feed = feed;
  }
  async load() {
    return (await this.feed.list()).resources;
  }
}

/** `FACTORY_DEFINITIONS_BACKEND` (spec name) wins over the older alias `FACTORY_DEFINITION_SOURCE`; default git. */
export function definitionsBackend(env: Record<string, string | undefined>): "git" | "kubernetes" {
  const v = env.FACTORY_DEFINITIONS_BACKEND ?? env.FACTORY_DEFINITION_SOURCE ?? "git";
  if (v !== "git" && v !== "kubernetes") throw new Error(`FACTORY_DEFINITIONS_BACKEND must be "git" or "kubernetes", got "${v}"`);
  return v;
}
