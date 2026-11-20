import { clone, matchesLabels, nsOf } from "../model/meta.ts";
import type { Resource } from "../model/resource.ts";
import {
  StoreError,
  type DefinitionFeed,
  type ListOptions,
  type ResourceStore,
  type SnapshotValidator,
  type Unsubscribe,
  type WatchEvent,
} from "../ports/index.ts";

export interface ReloadingStoreOptions {
  feed: DefinitionFeed;
  validator?: SnapshotValidator;
  /** Called when a candidate snapshot is rejected or the feed fails after startup. */
  onRejected?: (reason: string) => void;
  debounceMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const keyOf = (r: Resource) => `${nsOf(r)}/${r.kind}/${r.metadata.name}`;

/** Read-only definitions that live-reload: whole snapshots are validated, then swapped by one reference assignment. */
export class ReloadingDefinitionStore implements ResourceStore {
  private snapshot: ReadonlyMap<string, Resource> = new Map();
  private readonly o: ReloadingStoreOptions;
  private readonly listeners = new Set<(e: WatchEvent) => void>();
  private readonly reloadListeners = new Set<() => void>();
  private stopWatch?: Unsubscribe;
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();

  constructor(o: ReloadingStoreOptions) {
    this.o = o;
  }

  /** Fails fast when the first list fails or the first snapshot is invalid. */
  async init(): Promise<this> {
    const { resources, resourceVersion } = await this.o.feed.list();
    const problems = (await this.o.validator?.validate(resources)) ?? [];
    if (problems.length) throw new Error(`initial definitions are invalid: ${problems.join("; ")}`);
    this.snapshot = new Map(resources.map((r) => [keyOf(r), r]));
    this.stopWatch = this.o.feed.watch?.(resourceVersion, () => this.schedule());
    return this;
  }

  close(): void {
    this.stopWatch?.();
    if (this.timer) clearTimeout(this.timer);
  }

  onReload(l: () => void): Unsubscribe {
    this.reloadListeners.add(l);
    return () => this.reloadListeners.delete(l);
  }

  /** Resolves once pending reloads are applied. */
  async settled(): Promise<void> {
    await this.running;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.running.then(() => this.reload());
    }, this.o.debounceMs ?? 50);
  }

  async reload(): Promise<void> {
    let resources: Resource[];
    try {
      resources = (await this.o.feed.list()).resources;
    } catch (err) {
      this.o.log?.("definition relist failed; keeping last snapshot", err);
      this.o.onRejected?.(`relist failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const problems = (await this.o.validator?.validate(resources)) ?? [];
    if (problems.length) {
      this.o.onRejected?.(`snapshot rejected: ${problems.join("; ")}`);
      return;
    }
    const next = new Map(resources.map((r) => [keyOf(r), r]));
    const prev = this.snapshot;
    this.snapshot = next;
    const events: WatchEvent[] = [];
    for (const [k, r] of next) {
      const old = prev.get(k);
      if (!old) events.push({ type: "ADDED", object: clone(r) });
      else if (old.metadata.resourceVersion !== r.metadata.resourceVersion) events.push({ type: "MODIFIED", object: clone(r) });
    }
    for (const [k, r] of prev) if (!next.has(k)) events.push({ type: "DELETED", object: clone(r) });
    if (!events.length) return;
    for (const e of events) this.listeners.forEach((l) => l(e));
    this.reloadListeners.forEach((l) => l());
  }

  async get<R extends Resource = Resource>(kind: string, namespace: string, name: string): Promise<R | null> {
    const r = this.snapshot.get(`${namespace}/${kind}/${name}`);
    return r ? (clone(r) as R) : null;
  }

  async list<R extends Resource = Resource>(kind: string, o: ListOptions = {}): Promise<R[]> {
    return [...this.snapshot.values()]
      .filter((i) => i.kind === kind && (!o.namespace || nsOf(i) === o.namespace) && matchesLabels(i, o.labelSelector))
      .map((i) => clone(i) as R);
  }

  private readOnly(): never {
    throw new StoreError("definitions are read-only at runtime (edit them in Git or the cluster)", "ReadOnly");
  }
  async create<R extends Resource>(_: R): Promise<R> {
    return this.readOnly();
  }
  async update<R extends Resource>(_: R): Promise<R> {
    return this.readOnly();
  }
  async updateStatus<R extends Resource>(_: R): Promise<R> {
    return this.readOnly();
  }
  async delete(): Promise<void> {
    return this.readOnly();
  }
  watch(l: (e: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    const f = (e: WatchEvent) => (!kinds || kinds.includes(e.object.kind)) && l(e);
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
}

/** Reuses the admission ref validator against the candidate snapshot, so reload and admission agree. */
export function refSnapshotValidator(validators: import("../ports/index.ts").Validator[]): SnapshotValidator {
  return {
    async validate(resources) {
      const byKey = new Map(resources.map((r) => [keyOf(r), r]));
      const reader = {
        get: async (kind: string, namespace: string, name: string) => (byKey.get(`${namespace}/${kind}/${name}`) as never) ?? null,
        list: async (kind: string, o: ListOptions = {}) =>
          resources.filter((i) => i.kind === kind && (!o.namespace || nsOf(i) === o.namespace) && matchesLabels(i, o.labelSelector)) as never,
      };
      const problems: string[] = [];
      for (const r of resources)
        for (const v of validators)
          if (v.appliesTo(r.kind)) for (const p of await v.validate(r, { operation: "CREATE", reader })) problems.push(`${r.kind}/${r.metadata.name}: ${p}`);
      return problems;
    },
  };
}
