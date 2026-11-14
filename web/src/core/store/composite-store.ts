import { DEFAULT_NAMESPACE, type Resource } from "../model/resource.ts";
import { clone, matchesLabels, nsOf } from "../model/meta.ts";
import {
  StoreError,
  type DefinitionLoader,
  type KindLookup,
  type ListOptions,
  type ResourceStore,
  type StoreRouter,
  type Unsubscribe,
  type WatchEvent,
} from "../ports/index.ts";

/** Returns an error message if the candidate snapshot is invalid. */
export type Admit = (candidate: readonly Resource[]) => string | undefined | Promise<string | undefined>;

/** In-memory definition snapshot; changes are applied at runtime via apply/remove (serialized, admission-checked). */
export class DefinitionStore implements ResourceStore {
  private items: Resource[] = [];
  private readonly loader: DefinitionLoader;
  private readonly listeners = new Set<{ fn: (e: WatchEvent) => void; kinds?: string[] }>();
  private readonly admit?: Admit;
  private version = 0;
  private readonly pins = new Map<number, { items: readonly Resource[]; refs: number }>();

  constructor(loader: DefinitionLoader, admit?: Admit) {
    this.loader = loader;
    this.admit = admit;
  }

  /** Monotonic snapshot version, bumped on every admitted change. */
  get snapshotVersion(): number {
    return this.version;
  }

  /** Pin the current snapshot (a run starts on it). Returns its version. */
  acquireSnapshot(): number {
    const v = this.version;
    const p = this.pins.get(v);
    if (p) p.refs++;
    else this.pins.set(v, { items: this.items, refs: 1 });
    return v;
  }
  /** Release a pinned snapshot; dropped when the last pin ends. */
  releaseSnapshot(version: number): void {
    const p = this.pins.get(version);
    if (!p) return;
    if (--p.refs <= 0) this.pins.delete(version);
  }
  /** Retrieve a pinned (or the current) snapshot's definitions. */
  snapshot(version: number): readonly Resource[] | undefined {
    if (version === this.version) return this.items.map((i) => clone(i));
    return this.pins.get(version)?.items.map((i) => clone(i));
  }
  /** Metric: number of retained snapshots (pinned old ones plus current). */
  get snapshotCount(): number {
    return new Set([...this.pins.keys(), this.version]).size;
  }

  private key(r: Resource): string {
    return `${r.kind}/${nsOf(r)}/${r.metadata.name}`;
  }

  /** Apply (upsert) a definition. The whole candidate snapshot must pass admission; otherwise nothing changes. */
  apply(def: Resource): Promise<{ ok: boolean; reason?: string }> {
    return this.serial(() => this.doApply(def));
  }
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const r = this.tail.then(f, f);
    this.tail = r.catch(() => undefined);
    return r;
  }
  private async doApply(def: Resource): Promise<{ ok: boolean; reason?: string }> {
    const k = this.key(def);
    const idx = this.items.findIndex((i) => this.key(i) === k);
    const candidate = idx >= 0 ? this.items.map((i, n) => (n === idx ? clone(def) : i)) : [...this.items, clone(def)];
    const err = await this.admit?.(candidate);
    if (err) return { ok: false, reason: err };
    this.items = candidate;
    this.version++;
    this.emit({ type: idx >= 0 ? "MODIFIED" : "ADDED", object: clone(def) });
    return { ok: true };
  }

  /** Remove a definition; rejected if the remaining snapshot fails admission (e.g. still referenced). */
  remove(kind: string, namespace: string, name: string): Promise<{ ok: boolean; reason?: string }> {
    return this.serial(() => this.doRemove(kind, namespace, name));
  }
  private async doRemove(kind: string, namespace: string, name: string): Promise<{ ok: boolean; reason?: string }> {
    const found = this.items.find((i) => i.kind === kind && nsOf(i) === namespace && i.metadata.name === name);
    if (!found) return { ok: true };
    const candidate = this.items.filter((i) => i !== found);
    const err = await this.admit?.(candidate);
    if (err) return { ok: false, reason: err };
    this.items = candidate;
    this.version++;
    this.emit({ type: "DELETED", object: clone(found) });
    return { ok: true };
  }

  private emit(e: WatchEvent): void {
    for (const l of [...this.listeners]) if (!l.kinds || l.kinds.includes(e.object.kind)) {
      try {
        l.fn(e);
      } catch {
        /* a failing listener must not block others or undo the committed swap */
      }
    }
  }

  /** Bulk-apply a set (initial list): admitted as one candidate so mutually referencing definitions pass. */
  bulkApply(defs: Resource[]): Promise<{ ok: boolean; reason?: string }> {
    return this.serial(async () => {
      const byKey = new Map(this.items.map((i) => [this.key(i), i] as const));
      for (const d of defs) byKey.set(this.key(d), clone(d));
      const candidate = [...byKey.values()];
      const err = await this.admit?.(candidate);
      if (err) return { ok: false, reason: err };
      this.items = candidate;
      this.version++;
      return { ok: true };
    });
  }

  async init(): Promise<this> {
    this.items = await this.loader.load();
    return this;
  }

  async get<R extends Resource = Resource>(kind: string, namespace: string, name: string): Promise<R | null> {
    const r = this.items.find((i) => i.kind === kind && nsOf(i) === namespace && i.metadata.name === name);
    return r ? (clone(r) as R) : null;
  }

  async list<R extends Resource = Resource>(kind: string, o: ListOptions = {}): Promise<R[]> {
    return this.items
      .filter((i) => i.kind === kind && (!o.namespace || nsOf(i) === o.namespace) && matchesLabels(i, o.labelSelector))
      .map((i) => clone(i) as R);
  }

  private readOnly(): never {
    throw new StoreError("definitions are read-only at runtime (edit them in Git)", "ReadOnly");
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
  watch(fn: (e: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    const l = { fn, kinds };
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}

/** Routes each kind to the backend for its scope (definition vs runtime). */
export class ScopeRouter implements StoreRouter {
  private readonly kinds: KindLookup;
  private readonly definitions: ResourceStore;
  private readonly runtime: ResourceStore;
  constructor(kinds: KindLookup, definitions: ResourceStore, runtime: ResourceStore) {
    this.kinds = kinds;
    this.definitions = definitions;
    this.runtime = runtime;
  }
  route(kind: string): ResourceStore {
    const info = this.kinds.byKind(kind);
    if (!info) throw new StoreError(`unknown kind ${kind}`, "Invalid");
    return info.scope === "definition" ? this.definitions : this.runtime;
  }
}

export class CompositeStore implements ResourceStore {
  private readonly router: StoreRouter;
  private readonly backends: ResourceStore[];
  constructor(router: StoreRouter, backends: ResourceStore[]) {
    this.router = router;
    this.backends = backends;
  }
  get<R extends Resource = Resource>(kind: string, namespace: string, name: string) {
    return this.router.route(kind).get<R>(kind, namespace, name);
  }
  list<R extends Resource = Resource>(kind: string, o?: ListOptions) {
    return this.router.route(kind).list<R>(kind, o);
  }
  create<R extends Resource>(obj: R) {
    return this.router.route(obj.kind).create(obj);
  }
  update<R extends Resource>(obj: R) {
    return this.router.route(obj.kind).update(obj);
  }
  updateStatus<R extends Resource>(obj: R) {
    return this.router.route(obj.kind).updateStatus(obj);
  }
  delete(kind: string, namespace: string, name: string) {
    return this.router.route(kind).delete(kind, namespace ?? DEFAULT_NAMESPACE, name);
  }
  watch(listener: (e: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    const subs = this.backends.map((b) => b.watch(listener, kinds));
    return () => subs.forEach((u) => u());
  }
}
