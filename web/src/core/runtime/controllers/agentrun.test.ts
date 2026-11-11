import assert from "node:assert/strict";
import { test } from "node:test";
import { countToolCalls } from "./agentrun.ts";
import type { TranscriptMessage } from "../../ports/index.ts";

const ref = { namespace: "default", id: "t" };
function reader(msgs: TranscriptMessage[]) {
  return {
    async read(_r: unknown, o?: { afterSeq?: number; limit?: number }) {
      return msgs.filter((m) => m.seq > (o?.afterSeq ?? 0)).slice(0, o?.limit ?? 100);
    },
  };
}
const mk = (seq: number, role: TranscriptMessage["role"]): TranscriptMessage => ({ seq, at: "", role, author: { type: "agent", id: "a" }, content: "" });

test("counts tool-calls across pages, ignoring other roles", async () => {
  const msgs = Array.from({ length: 2500 }, (_, i) => mk(i + 1, i % 2 ? "tool-call" : "assistant"));
  assert.equal(await countToolCalls(reader(msgs), ref), 1250);
});

test("propagates reader errors", async () => {
  await assert.rejects(countToolCalls({ read: async () => { throw new Error("x"); } }, ref));
});
