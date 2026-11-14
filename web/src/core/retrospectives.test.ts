import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRun, Approval, Artifact, RetrospectiveFeedback, RetrospectiveFeedbackSpec, WorkItem } from "./model/kinds.ts";
import { LABEL_SUPERSEDED } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { ownerRef } from "./model/meta.ts";
import { ANONYMOUS as p, StoreError, type ExecutionContext, type ResourceWriter, type StatusWriter } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { SecretRedactor } from "./transcripts/recorder.ts";
import { DefaultFeedbackCapture } from "./retrospectives/capture.ts";
import { createFeedbackCaptureController } from "./retrospectives/capture-controller.ts";
import { DefaultRetrospectiveAggregation } from "./retrospectives/aggregation.ts";
import { DEFAULT_RETROSPECTIVE_POLICY } from "./retrospectives/evidence.ts";
import { DefaultRetrospectiveInvestigator } from "./retrospectives/investigator.ts";
import { RetrospectiveActions } from "./retrospectives/actions.ts";
import { RetrospectiveReview, retrospectiveContext } from "./retrospectives/review.ts";
import { feedbackDeletionGuard, retrospectiveValidator } from "./retrospectives/admission.ts";
import { createFactory, type Factory } from "./factory.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const capturedAt = "2026-11-14T12:00:00.000Z";
const clock = { now: () => new Date(capturedAt) };
const redactor = new SecretRedactor();

function harness() {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteStore(db, clock, [feedbackDeletionGuard]);
  const aggregation = new DefaultRetrospectiveAggregation(store, clock, DEFAULT_RETROSPECTIVE_POLICY);
  const investigator = new DefaultRetrospectiveInvestigator({ reader: store, writer: store, status: store, aggregation, clock });
  const actions = new RetrospectiveActions({ namespace: "default", reader: store, writer: store, aggregation, clock, redactor, events: new StoreEventRecorder(store) });
  return { db, store, aggregation, investigator, actions };
}

async function report(store: SqliteStore, name: string, role: string, patch: Partial<RetrospectiveFeedbackSpec> = {}, namespace = "default") {
  let item = await store.get<WorkItem>("WorkItem", namespace, name);
  if (!item) item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name, namespace },
    spec: { title: name, sourceRef: { name: "manual" }, workflowRef: { name: "business" } } });
  const run = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
    metadata: { name: `${name}-${role.toLowerCase()}`, namespace, ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name }, agentRef: { name: role }, skillRefs: [], inputs: [], outputs: [], stage: "triage", step: "investigate" },
    status: { phase: "Succeeded", executor: "llm", finishedAt: capturedAt } });
  const spec: RetrospectiveFeedbackSpec = {
    target: { namespace: "factory-system", name: "business", version: "v1", stage: "triage", workflowVersions: { "factory-system/business": "v1" } },
    observation: { stage: "triage", issueCode: "missing-repository-context", stance: "support", observation: "Repository context absent",
      impact: "Could not inspect code", suggestion: "Pass repository context", evidence: `AgentRun/${run.metadata.name} input lacked repository context` },
    reporter: { agent: role, role, kind: "agent" },
    origin: { workItem: name, workItemUid: item.metadata.uid!, agentRun: run.metadata.name, agentRunUid: run.metadata.uid! },
    capturedAt, executor: "llm", verified: true, replay: false, superseded: false, truncated: false, ...patch,
  };
  const feedback = await store.create<RetrospectiveFeedback>({ apiVersion: API_VERSION, kind: "RetrospectiveFeedback",
    metadata: { name: `feedback-${run.metadata.name}`, namespace }, spec });
  return { item, run, feedback };
}

test("retrospective support: exact origin/role threshold; duplicate, excluded, version and namespace evidence never inflate it", async () => {
  const h = harness();
  try {
    const first = await report(h.store, "one", "triager");
    await report(h.store, "one", "reviewer");
    await report(h.store, "two", "triager");
    let group = (await h.actions.list(p))[0];
    assert.equal(group.origins, 2); assert.equal(group.roles.length, 2); assert.equal(group.thresholdMet, false);
    for (const [name, patch] of Object.entries({
      replay: { replay: true }, simulated: { executor: "simulated" }, stale: { superseded: true },
      legacy: { verified: false }, expired: { capturedAt: "2026-10-01T12:00:00.000Z" },
      controller: { reporter: { agent: "controller", role: "controller", kind: "controller" as const } },
      positive: { observation: { ...first.feedback.spec.observation, stance: "positive" as const } },
      counter: { observation: { ...first.feedback.spec.observation, stance: "counterevidence" as const } },
    })) await report(h.store, name, "reviewer", patch);
    group = (await h.actions.list(p))[0];
    assert.equal(group.origins, 2); assert.equal(group.thresholdMet, false);
    await report(h.store, "three", "reviewer");
    group = (await h.actions.list(p))[0];
    assert.equal(group.origins, 3); assert.equal(group.thresholdMet, true);
    await report(h.store, "other-version", "reviewer", { target: { ...first.feedback.spec.target, version: "v2", workflowVersions: { "factory-system/business": "v2" } } });
    await report(h.store, "other-namespace", "reviewer", {}, "team-b");
    assert.equal((await h.actions.list(p)).length, 2);
    assert.equal((await h.aggregation.groups("team-b"))[0].origins, 1);
    await h.store.update({ ...first.run, metadata: { ...first.run.metadata, labels: { [LABEL_SUPERSEDED]: "true" } } });
    group = (await h.actions.list(p)).find((g) => g.target.version === "v1")!;
    assert.ok(group.reports.find((r) => r.feedback.metadata.name === first.feedback.metadata.name)?.exclusions.includes("Superseded"));
    await h.store.delete("WorkItem", "default", "two");
    assert.ok(await h.store.get("RetrospectiveFeedback", "default", "feedback-two-triager"));
    group = (await h.actions.list(p)).find((g) => g.target.version === "v1")!;
    assert.equal(group.origins, 2); assert.equal(group.thresholdMet, false);
  } finally { h.db.close(); }
});

test("capture validates opt-in and pinned chain, bounds/redacts evidence, and retries storage without rerunning an agent", async () => {
  const h = harness();
  try {
    const seed = await report(h.store, "capture", "triager");
    const recorder = { ref: { namespace: "default", id: "test" }, record: async () => {} };
    const ctx: ExecutionContext = {
      agent: { apiVersion: API_VERSION, kind: "Agent", metadata: { name: "triager" }, spec: { role: "Triage Engineer", retrospectiveFeedback: true }, body: "" },
      run: { ...seed.run, spec: { ...seed.run.spec, workflow: { target: { namespace: "factory-system", name: "business", version: "v1" },
        versions: { "factory-system/business": "v1", "factory-system/bolt": "v7" }, stage: "triage" } } },
      workItem: seed.item, skills: [], repositories: [], workspaces: [], inputs: [], approvals: [], clarifications: [], sections: [],
      workflowVersions: { "factory-system/business": "v1", "factory-system/bolt": "v7" }, transcript: recorder,
    };
    const capture = new DefaultFeedbackCapture({ redact: (text) => text.replaceAll("test-secret", "[REDACTED]") }, clock);
    const raw = { ...seed.feedback.spec.observation, observation: `test-secret ${"x".repeat(2000)}` };
    const result = capture.prepare(ctx, { provenance: { executor: "llm" }, feedback: [raw, { ...raw, stage: "ship" }, raw, raw] });
    assert.equal(result.candidates.length, 2); assert.equal(result.warnings.length, 2);
    assert.equal(result.candidates[0].verified, true); assert.equal(result.candidates[0].truncated, true);
    assert.equal(result.candidates[0].observation.observation.length, 1500);
    assert.match(result.candidates[0].observation.observation, /^\[REDACTED\]/);
    assert.equal(capture.prepare({ ...ctx, workflowVersions: { "factory-system/business": "v2" } }, { feedback: [raw] }).candidates[0].verified, false);
    assert.equal(capture.prepare({ ...ctx, run: seed.run }, { feedback: [raw] }).candidates[0].verified, false);
    assert.equal(capture.prepare({ ...ctx, agent: { ...ctx.agent, spec: { ...ctx.agent.spec, retrospectiveFeedback: false } } }, { feedback: [raw] }).candidates.length, 0);
    await h.store.updateStatus({ ...seed.run, status: { phase: "Succeeded", feedbackCandidates: result.candidates, feedbackWarnings: result.warnings } });
    await assert.rejects(h.store.delete("WorkItem", "default", seed.item.metadata.name), /Feedback capture.*pending/);
    await assert.rejects(h.store.delete("AgentRun", "default", seed.run.metadata.name), /Feedback capture.*pending/);
    assert.ok(await h.store.get("WorkItem", "default", seed.item.metadata.name), "cascade is rolled back while evidence is pending");
    let fail = true;
    const writer: ResourceWriter = {
      create: async (obj) => { if (obj.kind === "RetrospectiveFeedback" && fail) { fail = false; throw new Error("storage interrupted"); } return h.store.create(obj); },
      update: (obj) => h.store.update(obj), delete: (kind, ns, name) => h.store.delete(kind, ns, name),
    };
    const controller = createFeedbackCaptureController({ reader: h.store, writer, redactor });
    await assert.rejects(controller.reconcile(`default/${seed.run.metadata.name}`), /storage interrupted/);
    await assert.rejects(h.store.delete("WorkItem", "default", seed.item.metadata.name), /Feedback capture.*pending/);
    assert.equal((await h.store.get<AgentRun>("AgentRun", "default", seed.run.metadata.name))?.status?.phase, "Succeeded");
    await controller.reconcile(`default/${seed.run.metadata.name}`);
    const after = await h.store.list("RetrospectiveFeedback");
    await controller.reconcile(`default/${seed.run.metadata.name}`);
    assert.deepEqual(await h.store.list("RetrospectiveFeedback"), after);
    assert.equal((await h.store.list("Event")).length, 1, "warnings are durable and deduplicated");
    assert.ok((await controller.initialKeys()).includes(`default/${seed.run.metadata.name}`), "startup recovers completed candidates");
    await h.store.delete("WorkItem", "default", seed.item.metadata.name);
    assert.equal(await h.store.get("AgentRun", "default", seed.run.metadata.name), null);
    assert.deepEqual(await h.store.list("RetrospectiveFeedback"), after, "all independent evidence survives after the capture receipt permits deletion");
  } finally { h.db.close(); }
});

test("investigations recover create/status crashes, preserve cycles after deletion, and require explicit new human cycles", async () => {
  const h = harness();
  try {
    await report(h.store, "one", "triager"); await report(h.store, "two", "reviewer"); await report(h.store, "three", "triager");
    let fail = true;
    const status: StatusWriter = { updateStatus: async (obj) => { if (fail) { fail = false; throw new Error("status interrupted"); } return h.store.updateStatus(obj); } };
    const crashing = new DefaultRetrospectiveInvestigator({ reader: h.store, writer: h.store, status, aggregation: h.aggregation, clock });
    await assert.rejects(crashing.reconcile("default"), /status interrupted/);
    assert.equal((await h.store.list<WorkItem>("WorkItem")).filter((i) => i.spec.retrospective).length, 1);
    await h.investigator.reconcile("default");
    const group = (await h.actions.list(p))[0], investigation = group.investigations[0];
    const reports = await h.store.list<RetrospectiveFeedback>("RetrospectiveFeedback");
    await h.investigator.reconcile("default");
    assert.deepEqual(await h.store.list("RetrospectiveFeedback"), reports, "no idempotent status churn");
    assert.equal(investigation.spec.publicationDisabled, true);
    assert.equal(investigation.metadata.ownerReferences, undefined);
    await h.store.delete("WorkItem", "default", investigation.metadata.name);
    await h.investigator.reconcile("default");
    assert.equal((await h.actions.list(p))[0].investigations.length, 0, "deleted investigation must not be recreated");
    const latest = (await h.actions.list(p))[0];
    await assert.rejects(h.actions.investigate(p, latest.id, { requestId: "new-cycle", revision: "stale" }), /changed/);
    await h.actions.investigate(p, latest.id, { requestId: "new-cycle", revision: latest.revision });
    await h.investigator.reconcile("default");
    await h.actions.investigate(p, latest.id, { requestId: "new-cycle", revision: latest.revision });
    await h.investigator.reconcile("default");
    assert.equal((await h.actions.list(p))[0].investigations.length, 1);
    assert.equal((await h.actions.list(p))[0].investigations[0].spec.retrospective?.cycle, "new-cycle");
    await h.store.delete("WorkItem", "default", "one");
    const saved = await h.store.get<WorkItem>("WorkItem", "default", `${investigation.metadata.name.replace(/-auto$/, "")}-new-cycle`);
    assert.equal(saved?.spec.retrospective?.reports.length, 3);
  } finally { h.db.close(); }
});

test("retrospective human review binds proposal and current evidence, ignores additional reports, and bounds rejections", async () => {
  const h = harness();
  try {
    const first = await report(h.store, "one", "triager");
    const group = (await h.actions.list(p))[0];
    await h.actions.investigate(p, group.id, { requestId: "manual", revision: group.revision });
    await h.investigator.reconcile("default");
    let item = (await h.actions.list(p))[0].investigations[0];
    item = await h.store.updateStatus({ ...item, status: { phase: "AwaitingApproval", stage: "proposal-review", round: 2 } });
    const context: ExecutionContext = { workItem: item, run: first.run,
      agent: { apiVersion: API_VERSION, kind: "Agent", metadata: { name: "analyst" }, spec: { role: "Analyst" }, body: "" },
      skills: [], inputs: [], clarifications: [], approvals: [], repositories: [], workspaces: [], sections: [],
      transcript: { ref: { namespace: "default", id: "test" }, record: async () => {} } };
    const evidenceRevision = async () => (await retrospectiveContext(h.store, redactor).provide(context))[0].revision!;
    for (const [name, type] of [["analyst", "improvement-proposal"], ["reviewer", "improvement-review"]]) {
      const run = await h.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
        metadata: { name, namespace: "default", ownerReferences: [ownerRef(item)] },
        spec: { workItemRef: { name: item.metadata.name }, agentRef: { name }, skillRefs: [], stage: "proposal-review", step: name, inputs: [], outputs: [] },
        status: { phase: "Succeeded", provenance: { executor: "llm", definitions: {},
          inputs: Object.fromEntries((await h.store.list<Artifact>("Artifact")).map((a) => [a.metadata.name, a.metadata.resourceVersion!])),
          contexts: { "retrospective-evidence": await evidenceRevision() } } } });
      await h.store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
        metadata: { name: type, namespace: "default", ownerReferences: [ownerRef(item)] },
        spec: { artifactTypeRef: { name: type }, workItemRef: { name: item.metadata.name }, format: "markdown",
          content: `# ${type}\nEvidence-backed proposal`, producedBy: { agentRef: { name }, agentRunRef: { name: run.metadata.name } } } });
    }
    const review = new RetrospectiveReview(h.store);
    const ctx = { workItem: item, stage: { name: "proposal-review", origin: "factory-retrospective", lifecyclePhase: "improvement", steps: [] }, gate: { type: review.type } };
    const decision = await review.evaluate(ctx);
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") throw new Error("expected approval");
    const approval: Approval = { apiVersion: API_VERSION, kind: "Approval", metadata: { name: "review", namespace: "default" },
      spec: { workItemRef: { name: item.metadata.name }, stage: "proposal-review", approvers: [], retrospective: decision.retrospective } };
    await review.validate(approval, "approve");
    await report(h.store, "newer", "triager");
    await review.validate(approval, "approve");
    await h.actions.disposition(p, first.feedback.metadata.name, { version: (await h.store.get("RetrospectiveFeedback", "default", first.feedback.metadata.name))!.metadata.resourceVersion!,
      disposition: "dismissed", comment: "Contradicting evidence invalidates the earlier observation" });
    await assert.rejects(review.validate(approval, "approve"), /changed/);
    assert.equal((await review.evaluateApproval(ctx, { ...approval, spec: { ...approval.spec, decision: "approve" } })).action, "goto");
    assert.equal((await review.evaluate(ctx)).action, "goto", "invalidated support requires fresh AI review, not only a new approval");
    for (const name of ["analyst", "reviewer"]) {
      const run = (await h.store.get<AgentRun>("AgentRun", "default", name))!;
      await h.store.updateStatus({ ...run, status: { ...run.status!, provenance: { ...run.status!.provenance!,
        contexts: { "retrospective-evidence": await evidenceRevision() } } } });
    }
    const newDecision = await review.evaluate(ctx);
    if (newDecision.action !== "await-approval") throw new Error("expected fresh review");
    const fresh = { ...approval, spec: { ...approval.spec, retrospective: newDecision.retrospective, decision: "reject" as const } };
    assert.equal((await review.evaluateApproval({ ...ctx, workItem: { ...item, status: { ...item.status!, retries: { "proposal-review": 2 } } } }, fresh)).action, "end");
    const artifact = (await h.store.get<Artifact>("Artifact", "default", "improvement-proposal"))!;
    await h.store.update({ ...artifact, spec: { ...artifact.spec, content: "Different proposed change" } });
    await assert.rejects(review.validate(fresh, "approve"), /changed/);
    const validator = retrospectiveValidator();
    assert.deepEqual(await validator.validate(first.feedback, { operation: "UPDATE", oldObject: first.feedback, reader: h.store }), []);
    assert.match((await validator.validate({ ...first.feedback, spec: { ...first.feedback.spec, verified: false } },
      { operation: "UPDATE", oldObject: first.feedback, reader: h.store })).join(), /immutable/);
  } finally { h.db.close(); }
});

async function until<T>(get: () => Promise<T | undefined | false | null>, message: string): Promise<T> {
  for (let i = 0; i < 800; i++) {
    const value = await get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout: ${message}`);
}

test("X22 end to end: recorded feedback -> manual investigation -> independent review -> durable approval -> explicit publishing follow-up", async () => {
  const prompts: string[] = [];
  const fake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content?: string }[] };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    prompts.push(user);
    const observation = { stage: "triage", issueCode: "missing-ticket-history", stance: "support", observation: "Ticket history absent",
      impact: "Cannot establish earlier attempts", suggestion: "Include a bounded ticket history", evidence: "This triage input has no ticket history" };
    const type = system.includes("# Retrospective Analyst") ? "improvement-proposal" : system.includes("# Retrospective Reviewer") ? "improvement-review" : undefined;
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "Evidence examined", artifacts: type ? [{ type, content: `# ${type}\nPinned evidence; counterevidence considered. No automatic change.` }] : [],
      outcome: "accept", questions: [], feedback: system.includes("# Triager Agent") ? [observation] : undefined,
    }) } }] });
  };
  const directory = mkdtempSync(join(tmpdir(), "retrospective-test-"));
  const options = { definitionsRoot: ROOT, databasePath: join(directory, "factory.db"), env: { OPENAI_API_KEY: "sk-retrospective-fixture" }, fetch: fake };
  let f: Factory = await createFactory(options);
  try {
    await f.start();
    const origin = await f.app.createWorkItem(p, { title: "Investigate missing ticket history", description: "Investigate prior attempts and report whether the workflow supplied enough history." });
    const group = await until(async () => (await f.retrospectives.list(p)).find((g) => g.issueCode === "missing-ticket-history"), "feedback capture");
    assert.equal(group.origins, 1); assert.equal(group.thresholdMet, false);
    assert.ok(group.reports[0].feedback.spec.verified);
    assert.ok(group.reports[0].feedback.spec.target.workflowVersions["factory-system/factory-loop"]);
    await f.retrospectives.investigate(p, group.id, { requestId: "manual-investigation", revision: group.revision });
    const detail = await until(async () => {
      const item = (await f.retrospectives.list(p)).find((g) => g.id === group.id)?.investigations[0];
      if (!item) return;
      const d = await f.app.getWorkItem(p, item.metadata.name);
      if (d?.workItem.status?.phase === "Failed") throw new Error(d.workItem.status.message);
      return d?.workItem.status?.phase === "AwaitingApproval" ? d : undefined;
    }, "retrospective human review");
    assert.equal(detail.workspaces.length, 0); assert.equal(detail.outbox.length, 0);
    assert.equal(detail.runs.length, 2);
    assert.equal(new Set(detail.runs.map((r) => r.spec.agentRef.name)).size, 2);
    assert.ok(detail.approvals[0].spec.retrospective?.fingerprint);
    assert.ok(prompts.some((s) => s.includes("Untrusted retrospective evidence") && s.includes(group.reports[0].feedback.metadata.name)));
    await f.stop();
    f = await createFactory(options);
    await f.start();
    const restored = (await f.app.getWorkItem(p, detail.workItem.metadata.name))!;
    assert.equal(restored.approvals[0].metadata.uid, detail.approvals[0].metadata.uid, "human review survives process restart");
    assert.deepEqual(restored.workItem.spec.retrospective, detail.workItem.spec.retrospective);
    const originBefore = (await f.app.getWorkItem(p, origin.metadata.name))!.workItem;
    await f.app.decideApproval(p, detail.approvals[0].metadata.name, "approve");
    await until(async () => (await f.app.getWorkItem(p, detail.workItem.metadata.name))?.workItem.status?.phase === "Done", "approved proposal");
    assert.deepEqual((await f.app.getWorkItem(p, origin.metadata.name))!.workItem, originBefore);
    assert.equal((await f.retrospectives.list(p)).flatMap((g) => g.reports).length, 1, "retrospectives never recursively report feedback");
    const preview = await f.app.previewWorkItemFollowUp(p, detail.workItem.metadata.name);
    const input = { requestId: "implementation", expectedRevision: preview.revision, title: "Implement reviewed improvement",
      workflowRef: "factory-loop", repositoryRefs: ["software-factory"] };
    await assert.rejects(f.app.createWorkItemFollowUp(p, detail.workItem.metadata.name, input), /publication authorization/);
    const followup = await f.app.createWorkItemFollowUp(p, detail.workItem.metadata.name, { ...input, authorizePublication: true });
    assert.equal(followup.metadata.annotations?.["factory.ai-dlc.io/publication-authorized-by"], p.id);
    assert.equal(followup.spec.retrospective, undefined); assert.equal(followup.status, undefined);
    assert.ok(!f.exposedTools.some((t) => t.name.includes("retrospective")), "no agent mutation tools");
  } finally { await f.stop(); rmSync(directory, { recursive: true, force: true }); }
});
