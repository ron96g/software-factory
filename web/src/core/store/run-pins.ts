import type { DatabaseSync } from "node:sqlite";

/** Snapshot pin operations the registry needs (satisfied by DefinitionStore). */
export interface SnapshotPinner {
  acquireSnapshot(): number;
  releaseSnapshot(version: number): void;
}

/**
 * Records the snapshotVersion each run started on (additive table; existing tables untouched).
 * Pins live in memory in the store; after a restart unfinished runs re-pin to the current version.
 */
export class RunPins {
  private readonly db: DatabaseSync;
  private readonly store: SnapshotPinner;

  constructor(db: DatabaseSync, store: SnapshotPinner) {
    this.db = db;
    this.store = store;
    db.exec(`CREATE TABLE IF NOT EXISTS run_pins (
      run_id TEXT PRIMARY KEY, snapshot_version INTEGER NOT NULL);`);
  }

  /** A run starts: pin the current snapshot and persist its version. */
  start(runId: string): number {
    const v = this.store.acquireSnapshot();
    this.db.prepare("INSERT OR REPLACE INTO run_pins (run_id, snapshot_version) VALUES (?, ?)").run(runId, v);
    return v;
  }

  versionOf(runId: string): number | undefined {
    const r = this.db.prepare("SELECT snapshot_version AS v FROM run_pins WHERE run_id = ?").get(runId) as
      | { v: number }
      | undefined;
    return r?.v;
  }

  /** A run ends: release its pin (the snapshot is dropped when the last pin ends). */
  end(runId: string): void {
    const v = this.versionOf(runId);
    if (v === undefined) return;
    this.store.releaseSnapshot(v);
    this.db.prepare("DELETE FROM run_pins WHERE run_id = ?").run(runId);
  }

  /** After a process restart: every unfinished run re-pins to the current definitions. */
  repinAll(): string[] {
    const rows = this.db.prepare("SELECT run_id FROM run_pins").all() as { run_id: string }[];
    for (const { run_id } of rows) {
      const v = this.store.acquireSnapshot();
      this.db.prepare("UPDATE run_pins SET snapshot_version = ? WHERE run_id = ?").run(v, run_id);
    }
    return rows.map((r) => r.run_id);
  }
}
