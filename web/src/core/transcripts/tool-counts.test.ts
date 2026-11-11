import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteTranscriptStore } from "./sqlite-transcripts.ts";

test("toolCallCounts counts only tool-call rows per transcript", async () => {
  const s = new SqliteTranscriptStore(new DatabaseSync(":memory:"), { now: () => new Date() });
  const a = await s.open("default", { kind: "AgentRun", name: "a" });
  const b = await s.open("default", { kind: "AgentRun", name: "b" });
  const author = { type: "agent" as const, id: "x" };
  for (const role of ["tool-call", "tool-result", "tool-call", "assistant"] as const) await s.append(a, { role, author, content: "c" });
  const m = await s.toolCallCounts([a, b]);
  assert.equal(m.get(a.id), 2);
  assert.equal(m.get(b.id), 0);
});
