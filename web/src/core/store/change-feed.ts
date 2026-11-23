import type { DatabaseSync } from "node:sqlite";
import type { ChangeEntry, ChangeFeed, WatchEventType } from "../ports/index.ts";

/** How many change entries are kept before the oldest are dropped (ADR-0062 §1). */
export const DEFAULT_CHANGE_RETENTION = 10_000;

/**
 * ADR-0062 §1: the SQLite change feed. Rows are written by `SqliteStore` in the same transaction as the resource write,
 * so the feed is exactly the store's history. A consumer polls `since(cursor)`; when its cursor is older than the
 * retained range it must re-list (`resync: true`) rather than guess at what it missed.
 */
export class SqliteChangeFeed implements ChangeFeed {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async head(): Promise<number> {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq;
  }

  async since(cursor: number, kinds?: string[], limit = 1000): Promise<{ entries: ChangeEntry[]; cursor: number; resync: boolean }> {
    const oldest = (this.db.prepare("SELECT MIN(seq) AS seq FROM changes").get() as { seq: number | null }).seq;
    // Changes strictly between the cursor and the oldest retained row were pruned: the consumer cannot catch up.
    const resync = oldest !== null && cursor + 1 < oldest;
    const columns = "seq, type, kind, namespace, name, rv";
    const rows = (kinds?.length
      ? this.db.prepare(`SELECT ${columns} FROM changes WHERE seq > ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`).all(cursor, ...kinds, limit)
      : this.db.prepare(`SELECT ${columns} FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`).all(cursor, limit)) as
      { seq: number; type: string; kind: string; namespace: string; name: string; rv: number }[];
    const entries: ChangeEntry[] = rows.map((r) => ({
      seq: r.seq,
      type: r.type as WatchEventType,
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      resourceVersion: String(r.rv),
    }));
    return { entries, cursor: entries.length ? entries[entries.length - 1].seq : cursor, resync };
  }
}
