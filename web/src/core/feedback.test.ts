import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { testDefinitions } from "./testing/definitions.ts";
import { ANONYMOUS } from "./ports/index.ts";
import { LABEL_SUPERSEDED, type AgentRun, type InlineFeedback } from "./model/kinds.ts";
import { feedbackDelivery, pendingFeedbackFor } from "./model/feedback.ts";
import { feedbackViews } from "./app/feedback.ts";
import type { Artifact } from "./model/kinds.ts";

const p = ANONYMOUS;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const prompts: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const text = String(body.messages.map((m: { content: string }) => m.content).join("\n"));
    prompts.push(text);
    // Produce every artifact the output contract asks for, so there is a spec to annotate.
    const types = [...text.matchAll(/\{ "type": "([a-z-]+)", "content": "<[^>"]+>" \}/g)].map((m) => m[1]);
    const artifacts = [...new Set(types)].map((type) => ({ type, content: `# ${type}\n\nThe API responds within 2 seconds.\n\nUsers log in with a password.` }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", outcome: "accept", artifacts, questions: [] }) } }] });
  }) as typeof fetch;
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), definitionLoader: testDefinitions(), databasePath: ":memory:", env: { FACTORY_AGENT_RUNTIME: "tool-loop", FACTORY_SANDBOX_RUNTIME: "none", OPENAI_API_KEY: "sk-test-123456" }, fetch: fetchImpl, log: () => {} });
  await f.start();
  const wi = await f.app.createWorkItem(p, { title: "Inline feedback", description: "A long enough description for triage to accept it directly.", workflowRef: "test-loop" });
  const name = wi.metadata.name;
  const until = async (cond: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 1000; i++) {
      if (await cond()) return;
      await wait(15);
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const detail = async () => (await f.app.getWorkItem(p, name))!;
  const atGate = async () => {
    const d = await detail();
    return d.workItem.status?.phase === "AwaitingApproval" && d.workItem.status.stage === "spec-review";
  };
  return { f, name, prompts, until, detail, atGate };
}

test("ADR-0071: feedback drafts submitted at the spec-review gate reject it and reach the product owner exactly once", async () => {
  const { f, name, prompts, until, detail, atGate } = await setup();
  try {
    await until(atGate, "spec-review gate");
    const spec = (await detail()).artifacts.filter((a) => a.spec.artifactTypeRef.name === "spec").at(-1)!;
    await f.app.addFeedback(p, name, { artifact: spec.metadata.name, quote: "The API responds within 2 seconds.", comment: "Must be 200 ms at p95." });
    const second = await f.app.addFeedback(p, name, { artifact: spec.metadata.name, quote: "Users log in with a password.", comment: "Use SSO instead." });
    const dropped = await f.app.addFeedback(p, name, { artifact: spec.metadata.name, quote: "# spec", comment: "never mind" });
    await f.app.deleteFeedback(p, dropped.metadata.name);
    await f.app.updateFeedback(p, second.metadata.name, "Use the company SSO instead.");

    const d = await detail();
    assert.equal(d.feedback.length, 2);
    assert.ok(d.feedback.every((v) => v.state === "draft"));
    assert.deepEqual({ action: d.feedbackPlan?.action, stage: d.feedbackPlan?.stage, agents: d.feedbackPlan?.agents }, { action: "reject", stage: "spec", agents: ["product-owner"] });

    const before = prompts.length;
    const plan = await f.app.submitFeedback(p, name);
    assert.equal(plan.action, "reject");
    await assert.rejects(f.app.updateFeedback(p, second.metadata.name, "late edit"), /submitted feedback can't be changed/);

    await until(async () => (await detail()).feedback.every((v) => v.state === "addressed"), "feedback addressed");
    const rerun = prompts.slice(before).find((x) => x.includes("Human feedback on your earlier spec"));
    assert.ok(rerun, "the product owner's re-run received the feedback");
    assert.match(rerun, /> The API responds within 2 seconds\.\n\s+Feedback: Must be 200 ms at p95\./);
    assert.match(rerun, /Feedback: Use the company SSO instead\./);
    assert.match(rerun, /### The version they read\n# spec/, "the annotated version is attached");
    assert.ok(!rerun.includes("never mind"), "deleted drafts never reach the agent");
    assert.match(rerun, /later one wins/, "conflict rule is given for several notes on one artifact");
    const addressedBy = (await detail()).feedback[0].addressedBy!;
    const run = (await detail()).runs.find((r) => r.metadata.name === addressedBy)!;
    assert.equal(run.spec.step, "write-spec");
    assert.equal(run.status?.provenance?.feedback?.length, 2);

    // A later round of the same step does not get the already-addressed notes again.
    await until(atGate, "spec-review gate again");
    const open = (await detail()).approvals.find((a) => !a.spec.decision)!;
    const mark = prompts.length;
    await f.app.decideApproval(p, open.metadata.name, "reject", "One more pass please.");
    await until(async () => prompts.slice(mark).some((x) => x.includes("One more pass please.") && x.includes("write-spec")), "second re-run");
    assert.ok(!prompts.slice(mark).some((x) => x.includes("Human feedback on your earlier spec")), "notes are delivered once");
  } finally {
    await f.stop();
  }
});

test("ADR-0071: feedback submitted outside a matching gate restarts from the producing stage", async () => {
  const { f, name, prompts, until, detail, atGate } = await setup();
  try {
    await until(atGate, "spec-review gate");
    const open = (await detail()).approvals.find((a) => !a.spec.decision)!;
    await f.app.decideApproval(p, open.metadata.name, "approve");
    await until(async () => (await detail()).workItem.status?.stage !== "spec-review", "item to move past spec-review");
    const triage = (await detail()).artifacts.find((a) => a.spec.artifactTypeRef.name === "triage-decision")!;
    await f.app.addFeedback(p, name, { artifact: triage.metadata.name, quote: "Users log in with a password.", comment: "Out of scope." });
    assert.deepEqual((await detail()).feedbackPlan && { a: (await detail()).feedbackPlan!.action, s: (await detail()).feedbackPlan!.stage }, { a: "restart", s: "triage" });
    const before = prompts.length;
    await f.app.submitFeedback(p, name);
    await until(async () => prompts.slice(before).some((x) => x.includes("Human feedback on your earlier triage-decision")), "triager re-run with feedback");
    assert.ok((await detail()).events.some((e) => e.spec.reason === "Restarted"));
    assert.ok((await detail()).events.some((e) => e.spec.reason === "FeedbackSubmitted"));
  } finally {
    await f.stop();
  }
});

test("ADR-0071: a superseded run's notes are due again unless a newer note annotates that run's output", () => {
  const run = (name: string, feedback: string[], superseded = false) =>
    ({
      metadata: { name, labels: superseded ? { [LABEL_SUPERSEDED]: "x" } : {} },
      spec: { stage: "spec", step: "write-spec" },
      status: { phase: "Succeeded", provenance: { executor: "llm", definitions: {}, inputs: {}, feedback } },
    }) as unknown as AgentRun;
  const note = (name: string, onOutputOf: string) =>
    ({
      metadata: { name },
      spec: { submitted: { id: "b", at: "t", by: "h" }, producedBy: { agentRunRef: { name: onOutputOf }, stage: "spec", step: "write-spec" } },
    }) as unknown as InlineFeedback;
  const next = run("r9", []);

  // n1 reached r5, which a restart superseded: its change is gone, so n1 goes to the next run again.
  const lost = [note("n1", "r3")];
  assert.deepEqual(pendingFeedbackFor(next, lost, [run("r5", ["n1"], true)]).map((f) => f.metadata.name), ["n1"]);

  // n2 annotates r5's output, which already contains n1's change: only n2 is due.
  const covered = [note("n1", "r3"), note("n2", "r5")];
  const runs = [run("r5", ["n1"], true)];
  assert.deepEqual(pendingFeedbackFor(next, covered, runs).map((f) => f.metadata.name), ["n2"]);
  assert.equal(feedbackDelivery(covered, runs).get("n1")?.addressedBy, "r5");
});

test("ADR-0071: when the gate action fails, submitted notes go back to drafts", async () => {
  const { f, name, until, detail, atGate } = await setup();
  try {
    await until(atGate, "spec-review gate");
    const spec = (await detail()).artifacts.find((a) => a.spec.artifactTypeRef.name === "spec")!;
    await f.app.addFeedback(p, name, { artifact: spec.metadata.name, quote: "Users log in with a password.", comment: "Use SSO." });
    // Simulates the gate being decided by someone else between planning and rejecting.
    f.app.decideApproval = async () => {
      throw new Error("already decided");
    };
    await assert.rejects(f.app.submitFeedback(p, name), /already decided/);
    const d = await detail();
    assert.deepEqual(d.feedback.map((v) => v.state), ["draft"]);
    assert.equal(d.feedbackPlan?.drafts, 1);
  } finally {
    await f.stop();
  }
});

test("drafts on a replaced artifact are flagged, with whether the passage is still in the current version", () => {
  const artifact = (name: string, at: string, content: string, format = "markdown", superseded = false) => ({
    metadata: { name, creationTimestamp: at, labels: superseded ? { [LABEL_SUPERSEDED]: "r" } : {} },
    spec: { artifactTypeRef: { name: "implementation-plan" }, content, format },
  }) as unknown as Artifact;
  const note = (name: string, target: string, quote: string) => ({ metadata: { name },
    spec: { targetRef: { name: target }, quote, producedBy: { stage: "plan", step: "plan" } } }) as unknown as InlineFeedback;
  const artifacts = [
    artifact("v1", "2026-01-01", "Old **plan** text", "markdown", true),
    artifact("v2", "2026-01-02", JSON.stringify({ risks: "Old **plan**\ntext stays", decisions: [] }), "json"),
  ];
  const views = feedbackViews([note("kept", "v1", "Old plan text"), note("gone", "v1", "Removed passage"), note("fresh", "v2", "stays")], [], artifacts);
  assert.deepEqual(views.map((v) => v.outdated), [{ current: "v2", quoteFound: true }, { current: "v2", quoteFound: false }, undefined]);
});
