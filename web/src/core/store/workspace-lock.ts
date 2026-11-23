import type { DatabaseSync } from "node:sqlite";
import type { Clock, LockLease, WorkspaceLock } from "../ports/index.ts";

interface LockRow {
  holder: string;
  generation: number;
  expires_at: number;
}

/**
 * ADR-0062 §1/§2: a fenced, store-backed workspace lock. Expiry uses the **store's** clock, never the holder's; a claim
 * increments the generation so a previous holder's renew or release is rejected. Acquiring, renewing and releasing are
 * single transactions, so two processes cannot both win.
 */
export class SqliteWorkspaceLock implements WorkspaceLock {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_locks (
        key TEXT PRIMARY KEY, holder TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  async acquire(key: string, holder: string, ttlMs: number): Promise<LockLease | undefined> {
    const now = this.clock.now().getTime();
    let held = false;
    let lease: LockLease | undefined;
    this.tx(() => {
      const row = this.db.prepare("SELECT holder, generation, expires_at FROM workspace_locks WHERE key = ?").get(key) as LockRow | undefined;
      if (row && row.expires_at > now && row.holder !== holder) {
        held = true;
        return;
      }
      const generation = (row?.generation ?? 0) + 1;
      const expiresAt = now + ttlMs;
      this.db.prepare("INSERT OR REPLACE INTO workspace_locks (key, holder, generation, expires_at) VALUES (?, ?, ?, ?)")
        .run(key, holder, generation, expiresAt);
      lease = { holder, generation, expiresAt: new Date(expiresAt).toISOString() };
    });
    return held ? undefined : lease;
  }

  async renew(key: string, holder: string, generation: number, ttlMs: number): Promise<boolean> {
    const now = this.clock.now().getTime();
    const r = this.db
      .prepare("UPDATE workspace_locks SET expires_at = ? WHERE key = ? AND holder = ? AND generation = ? AND expires_at > ?")
      .run(now + ttlMs, key, holder, generation, now);
    return Number(r.changes) > 0;
  }

  async release(key: string, holder: string, generation: number): Promise<void> {
    this.db.prepare("DELETE FROM workspace_locks WHERE key = ? AND holder = ? AND generation = ?").run(key, holder, generation);
  }

  async get(key: string): Promise<LockLease | undefined> {
    const row = this.db.prepare("SELECT holder, generation, expires_at FROM workspace_locks WHERE key = ? AND expires_at > ?")
      .get(key, this.clock.now().getTime()) as LockRow | undefined;
    return row ? { holder: row.holder, generation: row.generation, expiresAt: new Date(row.expires_at).toISOString() } : undefined;
  }

  async list(prefix = ""): Promise<(LockLease & { key: string })[]> {
    const rows = this.db.prepare("SELECT key, holder, generation, expires_at FROM workspace_locks WHERE expires_at > ?")
      .all(this.clock.now().getTime()) as unknown as (LockRow & { key: string })[];
    return rows.filter((r) => r.key.startsWith(prefix)).map((r) => ({
      key: r.key, holder: r.holder, generation: r.generation, expiresAt: new Date(r.expires_at).toISOString(),
    }));
  }

  async releaseHolder(holder: string): Promise<number> {
    const r = this.db.prepare("DELETE FROM workspace_locks WHERE holder = ?").run(holder);
    return Number(r.changes);
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
}
