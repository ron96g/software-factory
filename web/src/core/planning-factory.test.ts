import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS as p } from "./ports/index.ts";
import type { PlanningDocument } from "./model/planning.ts";

test("opt-in factory plans autonomously, records context, batches decisions and requires fresh explicit approval after answers", async () => {
  const plan: PlanningDocument = {
    outcome: "Export authorized records.", scope: "CSV only.", approach: "Reuse the export service.",
    delivery: "Endpoint, then UI; each has acceptance tests.", acceptance: "AC-1: preserve tenant isolation.",
    risks: "Do not include personal data without a decision.",
    decisions: [{ id: "personal-data", question: "Include personal data?", options: ["Exclude", "Include"],
      recommendation: "Exclude", rationale: "Privacy policy is human-owned.", required: true }],
  };
  const additional = { id: "export-access", question: "Who can request an export?", options: ["Tenant admins", "All tenant users"],
    recommendation: "Tenant admins", rationale: "Access policy is human-owned.", required: true };
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const user: string = body.messages.at(-1).content;
    const step = /Stage: (\S+) · step: ([^\n]+)/.exec(user)?.[2];
    calls.push(step ?? "unknown");
    const artifacts: { type: string; content: string }[] = [];
    if (step === "research-impact") artifacts.push({ type: "research-notes", content: "Investigated repo:src/export.ts:10. Preserve tenant isolation." });
    if (step === "triage-signal") artifacts.push({ type: "triage-decision", content: "outcome: needs-info" });
    if (step === "write-spec") artifacts.push({ type: "spec", content: "AC-1: preserve tenant isolation. Export only authorized records." });
    if (step === "decompose-units") artifacts.push({ type: "units-of-work", content: "units: [endpoint, ui]" });
    if (step === "plan-verification") artifacts.push({ type: "validation-plan", content: JSON.stringify({
      criteria: [{ id: "AC-1", description: "Preserve tenant isolation", checks: [
        "software-factory/build", "software-factory/unit-tests", "software-factory/integration-tests",
        "software-factory/acceptance-criteria", "software-factory/security-scan",
      ] }],
      checks: ["software-factory/build", "software-factory/unit-tests", "software-factory/integration-tests",
        "software-factory/acceptance-criteria", "software-factory/security-scan"],
      preflight: ["software-factory/preflight"],
      units: [{ id: "U1", title: "Authorized export", dependsOn: [], criteria: ["AC-1"],
        obligations: [{ id: "U1-O1", description: "Export filters unauthorized records, with tests", checks: ["software-factory/unit-tests"] }] }],
    }) });
    if (step === "synthesize-plan") artifacts.push({ type: "implementation-plan", content: JSON.stringify(
      calls.filter((step) => step === "synthesize-plan").length > 1 ? { ...plan, decisions: [...plan.decisions, additional] } : plan) });
    if (step === "ai-plan-review") artifacts.push({ type: "review-report", content: "Consistent planning bundle. Explicit privacy decision needed." });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Completed research-backed planning step", artifacts,
      outcome: step === "triage-signal" ? "needs-info" : "approve",
      questions: step === "triage-signal" ? ["Include personal data?"] : [] }) } }] });
  };
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: ":memory:",
    env: { OPENAI_API_KEY: "test-planning-key", FACTORY_SANDBOX_RUNTIME: "none", FACTORY_SIMULATION: "wait" },
    fetch: fetchImpl, log: () => {} });
  await f.start();
  try {
    const item = await f.app.createWorkItem(p, { title: "Plan an authorized CSV export",
      description: "Allow tenant users to export their own records without crossing tenant boundaries.",
      context: "Reuse our existing service; no bulk export.", workflowRef: "factory-planned", repositoryRefs: ["software-factory"] });
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
    const initial = await waitForReview();
    assert.equal(initial.detail.clarifications.length, 0, "triage questions must not trigger an early interview");
    assert.equal(calls.filter((step) => step === "ai-plan-review").length, 1);
    const sheet = await f.planning.inspect(p, item.metadata.name);
    assert.equal(sheet.enabled, true);
    assert.equal(sheet.decisions.length, 1);
    assert.equal(sheet.ready, false);
    await assert.rejects(f.app.decideApproval(p, initial.approval.metadata.name, "approve",
      "Use the recommended default without asking", true), /required planning decision/);
    await f.planning.revise(p, item.metadata.name, { revision: sheet.revision, requestId: "privacy-answer", action: "decisions",
      answers: { "personal-data": "Exclude" } });
    const revised = await waitForReview(initial.approval.metadata.name);
    let workspace = await f.planning.inspect(p, item.metadata.name);
    assert.equal(workspace.batchSubmitted, true);
    assert.equal(workspace.decisions[0].answer, "Exclude");
    assert.equal(workspace.ready, false, "new required decisions remain blockers, not implicit defaults");
    await assert.rejects(f.app.decideApproval(p, revised.approval.metadata.name, "approve"), /required planning decision/);
    await f.planning.revise(p, item.metadata.name, { revision: workspace.revision, requestId: "access-answer", action: "decisions",
      answers: { "export-access": "Tenant admins" } });
    const final = await waitForReview(revised.approval.metadata.name);
    workspace = await f.planning.inspect(p, item.metadata.name);
    assert.deepEqual(workspace.decisions.map((decision) => decision.answer), ["Exclude", "Tenant admins"]);
    assert.equal(workspace.ready, true);
    assert.equal(final.approval.spec.decision, undefined);
    assert.equal(final.detail.clarifications.length, 0);
    assert.equal(calls.filter((step) => step === "write-spec").length, 3, "each human submission revises requirements exactly once");
    assert.equal(calls.filter((step) => step === "research-impact").length, 1, "settled research is not an interview loop");
    assert.ok(!calls.includes("write-code"), "construction cannot begin before explicit fresh plan approval");
    const reviewedRun = final.detail.runs.find((run) => run.spec.stage === "spec-review" && !run.metadata.labels?.["factory.ai-dlc.io/superseded"]);
    assert.ok(reviewedRun?.status?.provenance?.contexts?.["planning-intent"]);
    const transcript = await f.app.runTranscript(p, reviewedRun!.metadata.name);
    assert.ok(transcript.some((message) => message.content.includes("Planning contract and human decisions")));
    assert.ok(transcript.some((message) => message.content.includes('"answer": "Exclude"')));
    assert.ok(transcript.some((message) => message.content.includes('"answer": "Tenant admins"')));
    await assert.rejects(f.app.decideApproval(p, initial.approval.metadata.name, "approve"), /no longer open/);
    await assert.rejects(f.app.decideApproval(p, revised.approval.metadata.name, "approve"), /no longer open/);
    await f.app.decideApproval(p, final.approval.metadata.name, "approve");
  } finally { await f.stop(); }
});
