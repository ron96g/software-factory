import type { SourceHistory } from "../model/kinds.ts";

/** Total characters of comment bodies and change values stored per item (ADR-0070); newest kept. */
export const STORED_HISTORY_MAX_CHARS = 256_000;

/** Rough per-entry cost of author, timestamps and labels on top of the text. */
const ENTRY_OVERHEAD_CHARS = 100;
const sizeOf = (e: { body?: string; from?: string; to?: string }) => (e.body?.length ?? 0) + (e.from?.length ?? 0) + (e.to?.length ?? 0) + ENTRY_OVERHEAD_CHARS;

/** Drops the oldest comments and changes until the history fits; counts what was dropped in `omitted`. */
export function boundHistory(h: SourceHistory, maxChars = STORED_HISTORY_MAX_CHARS): SourceHistory {
  const all = [
    ...h.comments.map((c) => ({ at: c.createdAt, kind: "comments" as const, size: sizeOf(c), c })),
    ...h.changes.map((c) => ({ at: c.at, kind: "changes" as const, size: sizeOf(c), c })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  let used = 0;
  const keep = new Set<object>();
  const dropped = { comments: 0, changes: 0 };
  for (const e of all) {
    if (used + e.size <= maxChars) {
      used += e.size;
      keep.add(e.c);
    } else dropped[e.kind]++;
  }
  if (!dropped.comments && !dropped.changes) return h;
  const comments = (h.omitted?.comments ?? 0) + dropped.comments;
  const changes = (h.omitted?.changes ?? 0) + dropped.changes;
  return {
    ...h,
    comments: h.comments.filter((c) => keep.has(c)),
    changes: h.changes.filter((c) => keep.has(c)),
    omitted: { ...(comments ? { comments } : {}), ...(changes ? { changes } : {}) },
  };
}
