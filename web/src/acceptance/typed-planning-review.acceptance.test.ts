import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { ANONYMOUS as p } from "../core/ports/index.ts";
import type { PlanningReviewDocument } from "../core/model/planning-review.ts";
import type { WorkItemDetail } from "../core/ports/app.ts";

type Input = { name: string; resourceVersion: string; type: string };
type Reply = { document: unknown; outcome: string; questions?: string[] };
type Review = (inputs: Input[], attempt: number, prompt: string) => Reply;
const decision = { id: "data-policy", question: "Include personal data?", options: ["Exclude", "Include"],
  rationale: "Only the human can authorize this privacy boundary.", required: true };
const emptyReview = (): PlanningReviewDocument => ({ schemaVersion: "2", summary: "Reviewed the current proposal.", decisions: [], findings: [] });
const evidence = (inputs: Input[]) => inputs.filter((input) => input.type === "spec").map(({ name, resourceVersion }) => ({ artifact: { name, resourceVersion } }));

async function exercise(review: Review, run: (f: Factory, name: string, wait: (previous?: string) => Promise<WorkItemDetail>) => Promise<void>) {
  let reviewAttempts = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages.at(-1).content;
    const step = /Stage: (\S+) · step: ([^\n]+)/.exec(prompt)?.[2];
    const artifacts: { type: string; content: string }[] = [];
    let reply: Reply | undefined;
    if (step === "research-impact") artifacts.push({ type: "research-notes", content: "Research identifies the existing export boundary." });
    if (step === "triage-signal") artifacts.push({ type: "triage-decision", content: "outcome: accept" });
    if (step === "produce-plan") artifacts.push(
      { type: "spec", content: "AC-1: preserve tenant isolation." },
      { type: "units-of-work", content: "U1: authorized export endpoint." },
      { type: "implementation-plan", content: JSON.stringify({ risks: "Tenant isolation must remain intact.", decisions: [] }) },
      { type: "validation-plan", content: JSON.stringify({
        criteria: [{ id: "AC-1", description: "Preserve tenant isolation", checks: ["software-factory/unit-tests"] }],
        checks: ["software-factory/build", "software-factory/unit-tests", "software-factory/integration-tests",
          "software-factory/acceptance-criteria", "software-factory/security-scan"], preflight: ["software-factory/preflight"],
        units: [{ id: "U1", title: "Authorized export", dependsOn: [], criteria: ["AC-1"],
          obligations: [{ id: "U1-O1", description: "Enforce tenant authorization", checks: ["software-factory/unit-tests"] }] }],
      }) },
    );
    if (step === "ai-plan-review") {
      const marker = "## Required JSON contract: planning-review (from artifact-schema:planning-review)\n";
      assert.ok(prompt.includes(marker), "the exact schema is supplied to the reviewer");
      const contract: { inputs: Input[] } = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).split("\n\n## ")[0]);
      reply = review(contract.inputs, ++reviewAttempts, prompt);
      if (reply.document !== undefined) artifacts.push({ type: "planning-review", content: JSON.stringify(reply.document) });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "Planning test step", artifacts, outcome: step === "triage-signal" ? "accept" : reply?.outcome,
      questions: reply?.questions ?? [],
    }) } }] });
  };
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: ":memory:",
    env: { FACTORY_AGENT_RUNTIME: "tool-loop", OPENAI_API_KEY: "test-schema-key", FACTORY_SANDBOX_RUNTIME: "none", FACTORY_SIMULATION: "wait" },
    fetch: fetchImpl, log: () => {} });
  await f.start();
  try {
    const item = await f.app.createWorkItem(p, { title: "Typed planning review", description: "Export tenant-owned records." });
    const wait = async (previous?: string) => {
      for (let attempt = 0; attempt < 400; attempt++) {
        const detail = (await f.app.getWorkItem(p, item.metadata.name))!;
        if (detail.workItem.status?.phase === "Failed" ||
            detail.workItem.status?.phase === "AwaitingApproval" && detail.workItem.status.blockedBy?.name !== previous) return detail;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.fail(`Typed review did not stop: ${JSON.stringify((await f.app.getWorkItem(p, item.metadata.name))?.workItem.status)}`);
    };
    await run(f, item.metadata.name, wait);
  } finally { await f.stop(); }
}

test("AC-35-1: schema-invalid or inconsistent typed reviews never advance to approval", async (t) => {
  const cases: { name: string; review: Review; error: RegExp }[] = [
    { name: "extra properties", review: () => ({ document: { ...emptyReview(), hiddenQuestion: "Approve?" }, outcome: "approve" }), error: /additional properties/ },
    { name: "dangling human decision", review: (inputs) => ({ document: { ...emptyReview(), findings: [
      { id: "F1", kind: "human-decision", summary: "Choose the privacy policy.", evidence: evidence(inputs), decisionId: "missing" },
    ] }, outcome: "changes-requested" }), error: /required, answerable decision/ },
    { name: "orphan decision", review: () => ({ document: { ...emptyReview(), decisions: [decision] }, outcome: "approve" }), error: /must be referenced/ },
    { name: "stale evidence", review: (inputs) => ({ document: { ...emptyReview(), findings: [
      { id: "F1", kind: "advisory", summary: "Consider the boundary.", evidence: evidence(inputs).map((ref) => ({ artifact: { ...ref.artifact, resourceVersion: "stale" } })) },
    ] }, outcome: "approve" }), error: /exact reviewed input evidence/ },
    { name: "contradictory outcome", review: (inputs) => ({ document: { ...emptyReview(), findings: [
      { id: "F1", kind: "plan-defect", summary: "Missing authorization detail.", evidence: evidence(inputs), requestedChange: "Specify authorization." },
    ] }, outcome: "approve" }), error: /outcome contradicts/ },
    { name: "unstructured questions", review: () => ({ document: emptyReview(), outcome: "approve", questions: ["Which policy?"] }), error: /result.questions must be empty/ },
  ];
  for (const sample of cases) await t.test(sample.name, () => exercise(sample.review, async (f, name, wait) => {
    const detail = await wait();
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.match(detail.workItem.status?.message ?? "", sample.error);
    assert.equal(detail.approvals.length, 0);
    assert.equal(detail.clarifications.length, 0);
    assert.equal(detail.runs.filter((run) => run.spec.step === "produce-plan").length, 1, "only the malformed producing step retries");
    assert.equal(detail.runs.filter((run) => run.spec.step === "ai-plan-review").length, 3, "retry budget is bounded");
    const workspace = await f.planning.inspect(p, name);
    assert.equal(workspace.ready, false);
    assert.equal(workspace.readiness, "needs-agent-repair");
  }));
});

test("AC-35-2: reviewer questions become answerable decisions and cannot be bypassed by approval", async () => {
  await exercise((inputs, _attempt, prompt) => {
    if (prompt.includes('"answer": "Exclude"') && prompt.includes("re-asks answered decision")) return { document: emptyReview(), outcome: "approve" };
    const proposed = prompt.includes('"answer": "Exclude"') ? { ...decision, id: "data-policy-copy" } : decision;
    return { document: { ...emptyReview(), decisions: [proposed], findings: [
      { id: "F1", kind: "human-decision", summary: "Privacy policy needs a human answer.", decisionId: proposed.id, evidence: evidence(inputs) },
    ] }, outcome: "changes-requested" };
  }, async (f, name, wait) => {
    const initial = await wait();
    assert.equal(initial.workItem.status?.phase, "AwaitingApproval");
    let workspace = await f.planning.inspect(p, name);
    assert.equal(workspace.readiness, "needs-answers");
    assert.deepEqual(workspace.unansweredQuestions, [decision.question]);
    assert.deepEqual(workspace.decisions[0].options, decision.options);
    assert.equal(initial.clarifications.length, 0);
    const approval = initial.workItem.status!.blockedBy!.name;
    await assert.rejects(f.app.decideApproval(p, approval, "approve", "I accept all remaining concerns.", true), /required planning decision/);
    await f.planning.revise(p, name, { action: "decisions", requestId: "answer-policy", revision: workspace.revision,
      answers: { [decision.id]: "Exclude" } });
    const updated = await wait(approval);
    assert.equal(updated.workItem.status?.phase, "AwaitingApproval");
    workspace = await f.planning.inspect(p, name);
    assert.equal(workspace.recordedAnswers[0].answer, "Exclude");
    assert.deepEqual(workspace.unansweredQuestions, []);
    assert.ok(updated.events.some((event) => event.spec.reason === "OutputRejected" && event.spec.message.includes("re-asks answered decision data-policy-copy")),
      "repeating a settled decision under a new ID is rejected and repaired by the reviewer, not re-asked of the human");
    assert.equal(workspace.ready, true);
    const typed = updated.artifacts.filter((artifact) => artifact.spec.artifactTypeRef.name === "planning-review").at(-1)!;
    assert.equal(typed.spec.format, "json", "the ArtifactType owns the content format");
    const reviewer = updated.runs.find((run) => run.metadata.name === typed.spec.producedBy?.agentRunRef.name)!;
    assert.ok(reviewer.status?.provenance?.contexts?.["artifact-schema:planning-review"]);
  });
});

test("AC-35-3: unresolved research and plan findings remain visible and human-overridable with a reason", async () => {
  await exercise((inputs) => ({ document: { ...emptyReview(), findings: [
    { id: "F1", kind: "research-gap", summary: "Authorization assumptions remain unverified.",
      claim: "Existing exports enforce tenant isolation.", evidence: evidence(inputs),
      investigation: { checked: [], searches: ["tenant isolation export"], unresolvedBecause: "No export path exists yet to read." } },
  ] }, outcome: "changes-requested" }), async (f, name, wait) => {
    const detail = await wait();
    const workspace = await f.planning.inspect(p, name);
    assert.equal(workspace.readiness, "ready-with-findings");
    assert.equal(workspace.review?.findings[0].kind, "research-gap");
    assert.deepEqual(workspace.unansweredQuestions, [], "discoverable facts are not human questions");
    assert.ok(detail.events.some((event) => event.spec.reason === "LoopExhausted"));
    const approval = detail.workItem.status!.blockedBy!.name;
    await assert.rejects(f.app.decideApproval(p, approval, "approve"), /reason/);
    await f.app.decideApproval(p, approval, "approve", "I checked the existing authorization path and accept this bounded risk.");
  });
});

test("AC-35-4: malformed or missing reviews self-heal at their producing step without regenerating the plan", async (t) => {
  for (const missing of [false, true]) await t.test(missing ? "missing required artifact" : "schema error identifies the property",
    () => exercise((_inputs, attempt) => ({ document: attempt === 1 ? missing ? undefined : { ...emptyReview(), extra: true } : emptyReview(), outcome: "approve" }),
    async (f, name, wait) => {
      const detail = await wait();
      assert.equal(detail.workItem.status?.phase, "AwaitingApproval");
      assert.equal(detail.runs.filter((run) => run.spec.step === "produce-plan").length, 1);
      const reviews = detail.runs.filter((run) => run.spec.step === "ai-plan-review");
      assert.equal(reviews.length, 2);
      const transcript = await f.app.runTranscript(p, reviews.at(-1)!.metadata.name);
      assert.ok(transcript.some((message) => message.content.includes(missing ? "Missing required output: planning-review" : "additional properties")),
        "the author sees the validation error");
      if (!missing) assert.ok(transcript.some((message) => message.content.includes('"additionalProperty":"extra"')),
        "the correction identifies the exact unexpected property");
      assert.equal((await f.planning.inspect(p, name)).readiness, "ready");
    }));
});
