import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS, type PreparedWorkspace } from "./ports/index.ts";
import type { Workspace } from "./model/kinds.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("S5a: workspace is created at start, agents wait for Ready, provenance pins the commit, delete cleans up", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const removed: string[] = [];
  const backend = {
    supports: () => true,
    async prepare(ws: Workspace): Promise<PreparedWorkspace> {
      await gate; // simulate a slow setup (e.g. npm ci)
      return { path: ROOT, baseCommit: "abc123def", headCommit: "abc123def", preparedBy: "fake", setupLog: `prepared ${ws.metadata.name}` };
    },
    async remove(ws: Workspace) {
      removed.push(ws.metadata.name);
    },
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, workspaceBackend: backend, log: () => {} });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Workspace gating", description: "Long enough description so triage proceeds without questions." });
    await sleep(300);
    let d = (await f.app.getWorkItem(p, wi.metadata.name))!;
    assert.equal(d.workspaces.length, 1);
    assert.equal(d.workspaces[0].spec.branch, `factory/${wi.metadata.name}`);
    assert.equal(d.workspaces[0].status?.phase, "Preparing");
    assert.equal(d.runs.length, 0, "no agent runs before the workspace is Ready");

    release();
    for (let i = 0; i < 200; i++) {
      d = (await f.app.getWorkItem(p, wi.metadata.name))!;
      if (d.runs.some((r) => r.spec.step === "research-impact" && r.status?.phase === "Succeeded")) break;
      await sleep(20);
    }
    assert.equal(d.workspaces[0].status?.phase, "Ready");
    const research = d.runs.find((r) => r.spec.step === "research-impact")!;
    assert.deepEqual(research.status?.provenance?.workspaces, { "software-factory": "abc123def" });

    await f.app.deleteWorkItem(p, wi.metadata.name);
    for (let i = 0; i < 100 && !removed.length; i++) await sleep(20);
    assert.deepEqual(removed, [`${wi.metadata.name}-software-factory`]);
  } finally {
    await f.stop();
  }
});

test("S5a: a failed workspace fails the item with a visible reason", async () => {
  const backend = {
    supports: () => true,
    prepare: async (): Promise<PreparedWorkspace> => {
      throw new Error("setup failed: npm ci (exit 1)");
    },
    remove: async () => {},
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, workspaceBackend: backend, log: () => {} });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Broken setup", description: "x" });
    for (let i = 0; i < 200; i++) {
      const d = (await f.app.getWorkItem(p, wi.metadata.name))!;
      if (d.workItem.status?.phase === "Failed") {
        assert.match(d.workItem.status.message!, /workspace .* failed: setup failed: npm ci/);
        return;
      }
      await sleep(20);
    }
    assert.fail("item did not fail");
  } finally {
    await f.stop();
  }
});
