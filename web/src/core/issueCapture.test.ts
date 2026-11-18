import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";
import type { IssueProposal } from "./model/kinds.ts";
import { parseIssues } from "./agents/executors.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("parseIssues: tolerant and bounded", () => {
  assert.deepEqual(parseIssues("x"), []);
  assert.deepEqual(parseIssues([{ title: " t ", body: "b", labels: ["a", 1] }, { title: "", body: "b" }, null]), [{ title: "t", body: "b", labels: ["a"] }]);
});

test("AC-6: agents with the issue-proposal skill propose findings: max 5, redacted, no target, owned by the item", async () => {
  const fake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = String(body.messages[0].content ?? "");
    const proposes = system.includes("## Skill: issue-proposal");
    const issues = proposes ? Array.from({ length: 7 }, (_, i) => ({ title: `Finding ${i} sk-test-123456`, body: `Body ${i} sk-test-123456`, labels: ["x"] })) : [];
    const result = { summary: "ok", artifacts: [], outcome: "resolvable", questions: [], issues };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }) as typeof fetch;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_AGENT_RUNTIME: "tool-loop", OPENAI_API_KEY: "sk-test-123456" }, fetch: fake, log: () => {} });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(ANONYMOUS, { title: "Review me", description: "Find issues in the code base please.", workflowRef: "servicedesk" });
    const list = async () => (await f.app.listResources(ANONYMOUS, "issueproposals")) as IssueProposal[];
    const dbg = async () => JSON.stringify((await f.app.getWorkItem(ANONYMOUS, wi.metadata.name))?.workItem.status);
    const got = await waitFor(async () => { const l = await list(); return l.length >= 5 ? l : undefined; }, "proposals").catch(async (e) => { throw new Error(`${e.message} ${await dbg()}`); });
    await new Promise((r) => setTimeout(r, 100));
    const all = await list();
    assert.equal(all.length, 5, "cap of 5 per run");
    for (const p of all) {
      assert.equal(p.spec.purpose, "finding");
      assert.equal(p.spec.targetRef, undefined);
      assert.equal(p.spec.pickUp, false);
      assert.ok(!p.spec.title.includes("sk-test-123456") && !p.spec.body.includes("sk-test-123456"));
      assert.equal(p.metadata.ownerReferences?.[0]?.name, wi.metadata.name);
    }
    assert.ok(got.length >= 5);
  } finally {
    await f.stop();
  }
});
