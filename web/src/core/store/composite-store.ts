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

/** Read-only, in-memory view of definitions loaded once (reload = restart in the MVP). */
export class DefinitionStore implements ResourceStore {
  private items: Resource[] = [];
  private readonly loader: DefinitionLoader;

  constructor(loader: DefinitionLoader) {
    this.loader = loader;
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
  watch(_l: (e: WatchEvent) => void): Unsubscribe {
    return () => {};
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
