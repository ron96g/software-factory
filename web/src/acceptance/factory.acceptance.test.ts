import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { ANONYMOUS as p } from "../core/ports/index.ts";
import type { Workflow } from "../core/model/kinds.ts";

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
    const item = await f.app.createWorkItem(p, { title: "Acceptance: human in the loop", description: "short", workflowRef: "factory-loop" });
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

test("AC-30: one planner run, independent review, and withdrawn answers no longer steer planning", async () => {
  const calls: string[] = [];
  const plannerPrompts: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages.at(-1).content;
    const step = /Stage: (\S+) · step: ([^\n]+)/.exec(prompt)?.[2] ?? "unknown";
    calls.push(step);
    if (step === "produce-plan") plannerPrompts.push(prompt);
    const artifacts: { type: string; content: string }[] = [];
    if (step === "research-impact") artifacts.push({ type: "research-notes", content: "Research: repo:src/export.ts:10" });
    if (step === "triage-signal") artifacts.push({ type: "triage-decision", content: "outcome: accept" });
    if (step === "produce-plan") {
      artifacts.push({ type: "spec", content: "AC-1: export only authorized tenant records." });
      artifacts.push({ type: "units-of-work", content: "U1: authorized export endpoint." });
      artifacts.push({ type: "validation-plan", content: JSON.stringify({
        criteria: [{ id: "AC-1", description: "Export only authorized tenant records", checks: ["software-factory/unit-tests"] }],
        checks: ["software-factory/build", "software-factory/unit-tests", "software-factory/integration-tests",
          "software-factory/acceptance-criteria", "software-factory/security-scan"],
        preflight: ["software-factory/preflight"],
        units: [{ id: "U1", title: "Authorized export", dependsOn: [], criteria: ["AC-1"],
          obligations: [{ id: "U1-O1", description: "Enforce tenant authorization", checks: ["software-factory/unit-tests"] }] }],
      }) });
      artifacts.push({ type: "implementation-plan", content: JSON.stringify({
        risks: "Do not include personal data without a human decision.",
        decisions: [{ id: "personal-data", question: "Include personal data?", options: ["Exclude", "Include"],
          rationale: "This changes the privacy boundary.", required: true }],
      }) });
    }
    if (step === "ai-plan-review") artifacts.push({ type: "review-report", content: "The four artifacts agree." });
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "Completed planning step", artifacts,
      outcome: step === "triage-signal" ? "accept" : step === "ai-plan-review" ? "approve" : undefined,
    }) } }] });
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:",
    env: { OPENAI_API_KEY: "test-planner-key", FACTORY_SANDBOX_RUNTIME: "none", FACTORY_SIMULATION: "wait" },
    fetch: fetchImpl, log: () => {} });
  await f.start();
  try {
    const item = await f.app.createWorkItem(p, { title: "Plan an authorized export", description: "Export tenant-owned records." });
    assert.equal(item.spec.workflowRef?.name, "factory-plan", "new manual items default to the one-planner workflow");

    async function waitForReview(previous?: string) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const detail = (await f.app.getWorkItem(p, item.metadata.name))!;
        if (detail.workItem.status?.phase === "Failed") assert.fail(detail.workItem.status.message);
        const approval = detail.approvals.find((a) => a.metadata.name === detail.workItem.status?.blockedBy?.name);
        if (detail.workItem.status?.phase === "AwaitingApproval" && approval && approval.metadata.name !== previous) return { detail, approval };
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.fail(`Planning did not reach review: ${JSON.stringify((await f.app.getWorkItem(p, item.metadata.name))?.workItem.status)}`);
    }

    const first = await waitForReview();
    const bundle = first.detail.artifacts.filter((artifact) =>
      ["spec", "units-of-work", "validation-plan", "implementation-plan"].includes(artifact.spec.artifactTypeRef.name));
    assert.equal(bundle.length, 4);
    assert.equal(new Set(bundle.map((artifact) => artifact.spec.producedBy?.agentRunRef.name)).size, 1);
    assert.equal(calls.filter((step) => step === "produce-plan").length, 1);
    assert.equal(calls.filter((step) => step === "ai-plan-review").length, 1);
    assert.equal((await f.planning.inspect(p, item.metadata.name)).ready, false);
    const sheet = await f.planning.inspect(p, item.metadata.name);
    assert.equal(sheet.format, "decision-sheet", "ADR-0051: factory-plan's implementation plan is a focused decision sheet");
    assert.deepEqual(sheet.sources.map((source) => source.type), ["spec", "units-of-work", "validation-plan"]);
    const workflow = await f.app.getResource(p, "workflows", "factory-plan") as Workflow | null;
    const design = workflow?.spec.phases.flatMap((phase) => phase.stages).find((stage) => stage.name === "design");
    assert.equal(design?.gate?.type, "human-approval", "ADR-0051: a human approves the design before code is written");
    assert.deepEqual(design?.gate?.onReject, { next: "design" });

    let workspace = await f.planning.inspect(p, item.metadata.name);
    await f.planning.revise(p, item.metadata.name, { revision: workspace.revision, requestId: "answer-personal-data",
      action: "decisions", answers: { "personal-data": "Exclude" } });
    const second = await waitForReview(first.approval.metadata.name);
    workspace = await f.planning.inspect(p, item.metadata.name);
    assert.equal(workspace.recordedAnswers[0].answeredAt !== undefined, true);
    assert.equal(workspace.recordedAnswers[0].current, true);
    assert.equal(workspace.decisions[0].answer, "Exclude");
    assert.equal(calls.filter((step) => step === "produce-plan").length, 2);
    assert.equal(calls.filter((step) => step === "ai-plan-review").length, 2);
    await f.verification.validate(second.approval, "approve");

    await f.planning.revise(p, item.metadata.name, { revision: workspace.revision, requestId: "withdraw-personal-data",
      action: "decisions", withdraw: ["personal-data"] });
    const third = await waitForReview(second.approval.metadata.name);
    workspace = await f.planning.inspect(p, item.metadata.name);
    assert.equal(workspace.decisions[0].answer, undefined);
    assert.equal(workspace.recordedAnswers.length, 0);
    assert.equal(workspace.withdrawnAnswers.at(-1)?.answer, "Exclude");
    assert.equal(workspace.withdrawnAnswers.at(-1)?.question, "Include personal data?");
    assert.equal(workspace.ready, false, "withdrawing a required answer cannot authorize approval");
    assert.equal(calls.filter((step) => step === "produce-plan").length, 3);
    assert.equal(calls.filter((step) => step === "ai-plan-review").length, 3);
    assert.match(plannerPrompts.at(-1)!, /Treat every withdrawn answer as historical evidence only, explicitly no longer binding/);
    assert.match(plannerPrompts.at(-1)!, /"withdrawnAnswers": \[/);
    assert.match(plannerPrompts.at(-1)!, /"answer": "Exclude"/);
    await assert.rejects(f.app.decideApproval(p, third.approval.metadata.name, "approve"), /required planning decision/);
  } finally { await f.stop(); }
});
