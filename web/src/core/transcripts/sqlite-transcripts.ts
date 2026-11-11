import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  NewTranscriptMessage,
  TranscriptMessage,
  TranscriptReader,
  TranscriptStats,
  TranscriptRef,
  TranscriptTail,
  TranscriptWriter,
} from "../ports/index.ts";

/** Append-only transcript log (ADR-0012). No update/delete on purpose. */
export class SqliteTranscriptStore implements TranscriptWriter, TranscriptReader, TranscriptTail, TranscriptStats {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly tails = new Map<string, Set<(m: TranscriptMessage) => void>>();

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_messages (
        transcript_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, meta TEXT,
        PRIMARY KEY (transcript_id, seq));
    `);
  }

  async open(namespace: string, owner: { kind: string; name: string }): Promise<TranscriptRef> {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO transcripts (id, namespace, owner_kind, owner_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, namespace, owner.kind, owner.name, this.clock.now().toISOString());
    return { namespace, id };
  }

  async append(ref: TranscriptRef, m: NewTranscriptMessage): Promise<TranscriptMessage> {
    const exists = this.db.prepare("SELECT 1 FROM transcripts WHERE id = ?").get(ref.id);
    if (!exists) throw new Error(`transcript ${ref.id} not found`);
    const seq =
      ((this.db.prepare("SELECT MAX(seq) AS s FROM transcript_messages WHERE transcript_id = ?").get(ref.id) as { s: number | null })
        .s ?? 0) + 1;
    const msg: TranscriptMessage = { ...m, seq, at: m.at ?? this.clock.now().toISOString() };
    this.db
      .prepare(
        "INSERT INTO transcript_messages (transcript_id, seq, at, role, author, content, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ref.id, seq, msg.at, msg.role, JSON.stringify(msg.author), msg.content, msg.meta ? JSON.stringify(msg.meta) : null);
    for (const l of this.tails.get(ref.id) ?? []) l(msg);
    return msg;
  }

  async read(ref: TranscriptRef, o: { afterSeq?: number; limit?: number } = {}): Promise<TranscriptMessage[]> {
    const rows = this.db
      .prepare("SELECT * FROM transcript_messages WHERE transcript_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(ref.id, o.afterSeq ?? 0, o.limit ?? 10_000) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      at: r.at as string,
      role: r.role as TranscriptMessage["role"],
      author: JSON.parse(r.author as string),
      content: r.content as string,
      meta: r.meta ? JSON.parse(r.meta as string) : undefined,
    }));
  }

  async toolCallCounts(refs: TranscriptRef[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(refs.map((r) => [r.id, 0]));
    const ids = [...out.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT transcript_id AS id, COUNT(*) AS n FROM transcript_messages WHERE role = 'tool-call' AND transcript_id IN (${chunk.map(() => "?").join(",")}) GROUP BY transcript_id`,
        )
        .all(...chunk) as { id: string; n: number }[];
      for (const r of rows) out.set(r.id, r.n);
    }
    return out;
  }

  tail(ref: TranscriptRef, listener: (m: TranscriptMessage) => void): () => void {
    const set = this.tails.get(ref.id) ?? new Set();
    set.add(listener);
    this.tails.set(ref.id, set);
    return () => set.delete(listener);
  }
}
