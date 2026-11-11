import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

function fakeLLM(reviewOutcomes: string[]) {
  let reviews = 0;
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    const system = String(body.messages[0].content);
    let out: Record<string, unknown> = { summary: "ok", artifacts: [], outcome: "accept", questions: [] };
    if (system.includes("## Skill: code-review")) {
      const outcome = reviewOutcomes[Math.min(reviews++, reviewOutcomes.length - 1)];
      out = {
        summary: outcome === "approve" ? "LGTM" : "Missing test for the empty case",
        outcome,
        questions: [],
        artifacts: [{ type: "code-review-report", content: outcome === "approve" ? "No blocking findings." : "BLOCKING: add a test for the empty case (web/src/x.ts:12)." }],
      };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }) as typeof fetch;
}

async function runUntilCodeReviewGate(reviewOutcomes: string[]) {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-test-123456" }, fetch: fakeLLM(reviewOutcomes), log: () => {} });
  await f.start();
  const wi = await f.app.createWorkItem(p, { title: "Review loop", description: "A long enough description for triage to accept it directly." });
  for (let i = 0; i < 1000; i++) {
    const d = (await f.app.getWorkItem(p, wi.metadata.name))!;
    const st = d.workItem.status;
    if (st?.phase === "AwaitingApproval" && st.stage === "spec-review") {
      await f.app.decideApproval(p, d.approvals.find((a) => !a.spec.decision)!.metadata.name, "approve");
    } else if (st?.phase === "AwaitingApproval" && st.stage === "code-review") {
      return { f, d };
    } else if (st?.phase === "Failed") assert.fail(st.message);
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
}

test("Q1: AI review requests changes → developer re-runs with the review as input → approve → human gate", async () => {
  const { f, d } = await runUntilCodeReviewGate(["changes-requested", "approve"]);
  try {
    assert.equal(d.workItem.status?.retries?.["code-review"], 1);
    const writes = d.runs.filter((r) => r.spec.step === "write-code" && !r.spec.replayOf);
    assert.equal(writes.length, 2, "developer ran twice");
    assert.equal(d.runs.filter((r) => r.spec.step === "domain-model").length, 1, "design not repeated");
    const second = writes.at(-1)!;
    const inputs = Object.keys(second.status?.provenance?.inputs ?? {});
    assert.ok(inputs.some((n) => n.endsWith("code-review-report")), `review fed to developer: ${inputs.join(", ")}`);
    assert.equal(d.runs.filter((r) => r.spec.step === "ai-code-review").at(-1)?.status?.result?.outcome, "approve");
  } finally {
    await f.stop();
  }
});

test("Q1: loop is bounded; after maxAttempts the human gate decides (LoopExhausted)", async () => {
  const { f, d } = await runUntilCodeReviewGate(["changes-requested"]);
  try {
    assert.equal(d.workItem.status?.retries?.["code-review"], 2);
    assert.equal(d.runs.filter((r) => r.spec.step === "write-code").length, 3);
    await new Promise((r) => setTimeout(r, 300)); // further reconciles while waiting at the gate
    const after = (await f.app.getWorkItem(p, d.workItem.metadata.name))!;
    assert.equal(after.events.filter((e) => e.spec.reason === "LoopExhausted").length, 1, "emitted exactly once");
  } finally {
    await f.stop();
  }
});
