import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { ANONYMOUS as p } from "../core/ports/index.ts";

/**
 * Acceptance suite (`acceptance-criteria` check): product-level guarantees exercised through the public app API.
 * Add one test per delivered acceptance criterion, named with its ID, e.g. `AC-3: …`.
 */
const ROOT = resolve(import.meta.dirname, "../../..");

async function withFactory(fn: (f: Factory) => Promise<void>) {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, log: () => {} });
  await f.start();
  try { await fn(f); } finally { await f.stop(); }
}

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("Human in the loop: a new work item stops for a human with recorded agent work", async () => {
  await withFactory(async (f) => {
    const item = await f.app.createWorkItem(p, { title: "Acceptance: human in the loop", description: "short" });
    const detail = await waitFor(async () => {
      const d = await f.app.getWorkItem(p, item.metadata.name);
      return d && ["Blocked", "AwaitingApproval"].includes(d.workItem.status?.phase ?? "") ? d : undefined;
    }, "a human stop");
    assert.ok(detail.clarifications.some((c) => !c.spec.answers?.length) || detail.approvals.some((a) => !a.spec.decision),
      "the stop is a pending human Clarification or Approval");
    const runs = detail.runs.filter((r) => r.status?.phase === "Succeeded");
    assert.ok(runs.length > 0, "agents did work before asking");
    for (const run of runs) assert.ok((await f.app.runTranscript(p, run.metadata.name)).length > 0, `${run.metadata.name} is recorded`);
  });
});

test("Gates stay human: the MCP surface offers no tool to approve, reject, override or waive", async () => {
  await withFactory(async (f) => {
    const names = f.exposedTools.map((tool) => tool.name);
    assert.ok(names.includes("create_work_item"));
    assert.deepEqual(names.filter((name) => /approv|reject|override|waive|decide/i.test(name)), []);
  });
});

test("AC-4: truncated tool results are flagged in the transcript", async () => {
  const { DefaultRecordedToolTurns } = await import("../core/agents/recorded-tool-turns.ts");
  const { formatMarker } = await import("../core/agents/truncation.ts");
  const records: any[] = [];
  await new DefaultRecordedToolTurns().invoke({
    call: { name: "read_file", arguments: {} },
    tool: { invoke: async () => `x\n${formatMarker("read_file", 5, "startLine=9")}` },
    transcript: { record: async (r: any) => { records.push(r); } }, agent: "a", step: "s", turnId: "t",
  } as any);
  assert.deepEqual(records.find((r) => r.role === "tool-result").meta.truncated, { omitted: "5", next: "startLine=9" });
});
