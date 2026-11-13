import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { API_VERSION, DEFAULT_NAMESPACE, type Resource } from "../model/resource.ts";
import { clone, matchesLabels } from "../model/meta.ts";
import {
  StoreError,
  type Clock,
  type ListOptions,
  type ResourceStore,
  type Unsubscribe,
  type WatchEvent,
} from "../ports/index.ts";

/**
 * Runtime store on node:sqlite (ADR-0004). One table, key (namespace, kind, name).
 * resourceVersion is a global monotonic counter; status is written only via updateStatus.
 */
export class SqliteStore implements ResourceStore {
  private readonly listeners = new Set<{ fn: (e: WatchEvent) => void; kinds?: string[] }>();
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        namespace TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        uid TEXT NOT NULL UNIQUE, rv INTEGER NOT NULL, doc TEXT NOT NULL,
        PRIMARY KEY (namespace, kind, name));
      CREATE TABLE IF NOT EXISTS owners (uid TEXT NOT NULL, owner_uid TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS owners_by_owner ON owners(owner_uid);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters VALUES ('rv', 0);
    `);
  }

  async get<R extends Resource = Resource>(kind: string, namespace: string, name: string): Promise<R | null> {
    const row = this.db
      .prepare("SELECT doc FROM resources WHERE namespace = ? AND kind = ? AND name = ?")
      .get(namespace, kind, name) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as R) : null;
  }

  async list<R extends Resource = Resource>(kind: string, options: ListOptions = {}): Promise<R[]> {
    const rows = (
      options.namespace
        ? this.db.prepare("SELECT doc FROM resources WHERE kind = ? AND namespace = ? ORDER BY rv").all(kind, options.namespace)
        : this.db.prepare("SELECT doc FROM resources WHERE kind = ? ORDER BY rv").all(kind)
    ) as { doc: string }[];
    return rows
      .map((r) => JSON.parse(r.doc) as R)
      .filter((r) => matchesLabels(r, options.labelSelector))
      .filter(
        (r) =>
          !options.ownedBy ||
          (r.metadata.ownerReferences ?? []).some(
            (o) => o.kind === options.ownedBy!.kind && o.name === options.ownedBy!.name,
          ),
      );
  }

  async create<R extends Resource>(input: R): Promise<R> {
    const obj = clone(input);
    obj.apiVersion ??= API_VERSION;
    obj.metadata.namespace ??= DEFAULT_NAMESPACE;
    const generated = !obj.metadata.name && !!obj.metadata.generateName;
    if (!obj.metadata.name && !generated) throw new StoreError("metadata.name is required", "Invalid");
    obj.metadata.uid = randomUUID();
    obj.metadata.creationTimestamp = this.clock.now().toISOString();
    const ns = obj.metadata.namespace;
    this.tx(() => {
      if (generated) {
        for (let attempt = 0; attempt < 8; attempt++) {
          obj.metadata.name = obj.metadata.generateName + randomUUID().replaceAll("-", "").slice(0, 16);
          if (!this.exists(obj.kind, ns, obj.metadata.name)) break;
          if (attempt === 7) throw new StoreError("could not allocate a unique generated resource name", "Conflict");
        }
      }
      if (this.exists(obj.kind, ns, obj.metadata.name)) {
        throw new StoreError(`${obj.kind} ${ns}/${obj.metadata.name} already exists`, "AlreadyExists");
      }
      obj.metadata.resourceVersion = String(this.nextRv());
      this.db
        .prepare("INSERT INTO resources (namespace, kind, name, uid, rv, doc) VALUES (?, ?, ?, ?, ?, ?)")
        .run(ns, obj.kind, obj.metadata.name, obj.metadata.uid!, Number(obj.metadata.resourceVersion), JSON.stringify(obj));
      for (const o of obj.metadata.ownerReferences ?? []) {
        this.db.prepare("INSERT INTO owners (uid, owner_uid) VALUES (?, ?)").run(obj.metadata.uid!, o.uid);
      }
    });
    this.emit({ type: "ADDED", object: obj });
    return clone(obj);
  }

  async update<R extends Resource>(input: R): Promise<R> {
    return this.write(input, (current, next) => {
      next.status = current.status; // spec writers cannot touch status
      next.metadata.uid = current.metadata.uid;
      next.metadata.creationTimestamp = current.metadata.creationTimestamp;
      next.metadata.ownerReferences = current.metadata.ownerReferences;
    });
  }

  async updateStatus<R extends Resource>(input: R): Promise<R> {
    return this.write(input, (current, next) => {
      const status = next.status;
      Object.assign(next, clone(current));
      next.status = status;
    });
  }

  async delete(kind: string, namespace: string, name: string): Promise<void> {
    const obj = await this.get(kind, namespace, name);
    if (!obj) throw new StoreError(`${kind} ${namespace}/${name} not found`, "NotFound");
    const deleted: Resource[] = [];
    this.tx(() => this.deleteCascade(obj, deleted));
    for (const d of deleted) this.emit({ type: "DELETED", object: d });
  }

  watch(listener: (event: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    const entry = { fn: listener, kinds };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private write<R extends Resource>(input: R, merge: (current: Resource, next: Resource) => void): Promise<R> {
    const ns = input.metadata.namespace ?? DEFAULT_NAMESPACE;
    let result!: R;
    this.tx(() => {
      const row = this.db
        .prepare("SELECT doc, rv FROM resources WHERE namespace = ? AND kind = ? AND name = ?")
        .get(ns, input.kind, input.metadata.name) as { doc: string; rv: number } | undefined;
      if (!row) throw new StoreError(`${input.kind} ${ns}/${input.metadata.name} not found`, "NotFound");
      if (input.metadata.resourceVersion !== String(row.rv)) {
        throw new StoreError(
          `conflict on ${input.kind} ${ns}/${input.metadata.name}: have ${input.metadata.resourceVersion}, current ${row.rv}`,
          "Conflict",
        );
      }
      const next = clone(input) as Resource;
      next.metadata.namespace = ns;
      merge(JSON.parse(row.doc) as Resource, next);
      next.metadata.resourceVersion = String(this.nextRv());
      this.db
        .prepare("UPDATE resources SET rv = ?, doc = ? WHERE namespace = ? AND kind = ? AND name = ?")
        .run(Number(next.metadata.resourceVersion), JSON.stringify(next), ns, input.kind, input.metadata.name);
      result = next as R;
    });
    this.emit({ type: "MODIFIED", object: result });
    return Promise.resolve(clone(result));
  }

  private deleteCascade(obj: Resource, deleted: Resource[]): void {
    const uid = obj.metadata.uid!;
    const children = this.db
      .prepare("SELECT r.doc FROM owners o JOIN resources r ON r.uid = o.uid WHERE o.owner_uid = ?")
      .all(uid) as { doc: string }[];
    for (const c of children) this.deleteCascade(JSON.parse(c.doc) as Resource, deleted);
    this.db.prepare("DELETE FROM resources WHERE uid = ?").run(uid);
    this.db.prepare("DELETE FROM owners WHERE uid = ? OR owner_uid = ?").run(uid, uid);
    deleted.push(obj);
  }

  private exists(kind: string, namespace: string, name: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM resources WHERE namespace = ? AND kind = ? AND name = ?")
      .get(namespace, kind, name);
  }

  private nextRv(): number {
    this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'rv'").run();
    return (this.db.prepare("SELECT value FROM counters WHERE name = 'rv'").get() as { value: number }).value;
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private emit(event: WatchEvent): void {
    for (const l of this.listeners) {
      if (l.kinds && !l.kinds.includes(event.object.kind)) continue;
      try {
        l.fn(clone(event));
      } catch {
        // a faulty listener must not break writes
      }
    }
  }
}
