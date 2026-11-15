import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultRecordedToolTurns } from "./recorded-tool-turns.ts";
import { formatMarker } from "./truncation.ts";

const run = async (result: string) => {
  const records: any[] = [];
  const transcript = { record: async (r: any) => { records.push(r); } };
  await new DefaultRecordedToolTurns().invoke({
    call: { name: "read_file", arguments: {} }, tool: { invoke: async () => result },
    transcript, agent: "a", step: "s", turnId: "t",
  } as any);
  return records.find((r) => r.role === "tool-result");
};

test("recorder flags truncated results", async () => {
  const r = await run(`x\n${formatMarker("read_file", 5, "startLine=9")}`);
  assert.deepEqual(r.meta.truncated, { omitted: "5", next: "startLine=9" });
});

test("recorder marks untruncated results false", async () => {
  assert.equal((await run("fine")).meta.truncated, false);
});
