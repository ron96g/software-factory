import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";

const p = ANONYMOUS;

test("X7: gate comments reach later agents (delegation on approve; feedback on reject)", async () => {
  const prompts: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    prompts.push(String(body.messages.map((m: { content: string }) => m.content).join("\n")));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", outcome: "accept", artifacts: [], questions: [] }) } }] });
  }) as typeof fetch;
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-test-123456" }, fetch: fetchImpl, log: () => {} });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Delegate decisions", description: "A long enough description for triage to accept it directly." });
    let decided = 0;
    for (let i = 0; i < 1000 && decided < 2; i++) {
      const d = (await f.app.getWorkItem(p, wi.metadata.name))!;
      const open = d.approvals.find((a) => !a.spec.decision);
      if (d.workItem.status?.phase === "AwaitingApproval" && open) {
        if (decided === 0) await f.app.decideApproval(p, open.metadata.name, "reject", "Spec lacks NFRs: add a performance target.");
        else await f.app.decideApproval(p, open.metadata.name, "approve", "Delegated by the human: use the reviewer's recommended option for all open decisions.");
        decided++;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    // let the next stage (design) run with the decisions in context
    for (let i = 0; i < 300 && !prompts.some((x) => x.includes("Human gate decision (spec-review): APPROVE")); i++) await new Promise((r) => setTimeout(r, 15));
    assert.ok(prompts.some((x) => /Human gate decision \(spec-review\): REJECT\nSpec lacks NFRs/.test(x) && /Address this feedback first/.test(x)), "reject reason reached the re-run spec");
    assert.ok(prompts.some((x) => /Human gate decision \(spec-review\): APPROVE\nDelegated by the human/.test(x)), "delegation reached later agents");
  } finally {
    await f.stop();
  }
});
