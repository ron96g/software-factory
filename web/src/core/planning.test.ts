import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Approval, Artifact, CheckRun, OutboxMessage, Repository, WorkItem, Workflow } from "./model/kinds.ts";
import type { PlanningDocument } from "./model/planning.ts";
import { LABEL_SUPERSEDED } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { ANONYMOUS as p, type GateEvaluator, type PlanningRevisionInput } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { PlanningService, parsePlanningDocument } from "./planning/service.ts";
import { planningIntent } from "./planning/evidence.ts";
import { planningReview } from "./planning/review.ts";
import { VerificationService } from "./verification/service.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { Registry } from "./registry/registry.ts";

const document: PlanningDocument = {
  outcome: "Customers can export their own records.", scope: "Include CSV. Exclude bulk tenant exports.",
  approach: "Reuse the existing export service (repo:src/export.ts:10).", delivery: "Unit 1: endpoint. Unit 2: UI after Unit 1.",
  acceptance: "AC-1: export only authorized records. Check repo/test; human checks the downloaded file.",
  risks: "Tenant isolation; validate authorization server-side.",
  decisions: [],
};
const required = { id: "sensitive-data", question: "Include personal data?", options: ["Exclude", "Include"],
  recommendation: "Exclude", rationale: "Changes the privacy boundary.", required: true };

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-14T13:00:00Z") };
  const store = new SqliteStore(db, clock);
  const compiler = new DefaultWorkflowCompiler(store);
  const events = new StoreEventRecorder(store);
  const redactor = { redact: (text: string) => text.replaceAll("secret-value", "[REDACTED]") };
  const planning = new PlanningService({ namespace: "default", reader: store, writer: store, compiler, events, redactor });
  const workflow = await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "planned", namespace: "factory-system" },
    spec: { planning: { revisionStage: "spec", synthesisStage: "implementation-plan", reviewStage: "spec-review" },
      verification: { planningStage: "validation-plan", reviewStage: "spec-review", preflightStage: "preflight",
        implementationStage: "implement", verifyStage: "verify", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 1000 },
      phases: [{ name: "inception", stages: [
        { name: "triage", steps: [{ name: "triage", agentRef: { name: "triager" } }] },
        { name: "spec", steps: [{ name: "write", agentRef: { name: "product-owner" } }] },
        { name: "validation-plan" }, { name: "implementation-plan" },
        { name: "spec-review", gate: { type: "verification-plan-review" } },
      ] }, { name: "construction", stages: [
        { name: "preflight", gate: { type: "verified-checks" } },
        { name: "implement", steps: [{ name: "write", agentRef: { name: "developer" } }] },
        { name: "code-review", gate: { type: "verification-candidate-review" } },
        { name: "verify", gate: { type: "verified-checks" } },
      ] }] } });
  await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
    spec: { checks: { test: "tests", preflight: "prepare" }, verification: { requiredChecks: ["test"], preflightChecks: ["preflight"] } } });
  await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
    spec: { title: "Export", sourceRef: { name: "manual" }, workflowRef: { name: "planned" }, repositoryRefs: [{ name: "repo" }] },
    status: { phase: "AwaitingApproval", stage: "spec-review", round: 5 } });
  const item = async () => (await store.get<WorkItem>("WorkItem", "default", "item"))!;
  const verification = new VerificationService({ namespace: "default", reader: store, writer: store, compiler,
    snapshots: { fingerprint: async () => "tree" }, scheduler: { submit: async () => { throw new Error("checks must not run while planning"); } },
    environments: { select: async () => { throw new Error("planning must not execute a sandbox"); }, refresh: async () => {} },
    planning, planReview: planning, events, clock, redactor });
  const gates = new Registry<GateEvaluator>();
  for (const gate of verification.gates) gates.register(gate.type, gate.type === "verification-plan-review" ? planningReview(gate, compiler) : gate);
  const controller = createWorkItemController({ reader: store, writer: store, status: store, compiler, events, clock, gates,
    workspaces: { supports: () => false }, outbox: { enqueue: async () => { throw new Error("planning must never publish"); } },
    questionPolicy: planning, intentPolicy: planning, stagePolicy: verification });
  let generation = 0;
  async function seed(plan: PlanningDocument = document) {
    generation++;
    const wi = await item();
    const artifacts: Artifact[] = [];
    for (const [type, stage, author, inputs, content] of [
      ["spec", "spec", "product-owner", [], "AC-1: export only authorized records"],
      ["units-of-work", "spec", "architect", [0], "units: [endpoint, ui]"],
      ["validation-plan", "validation-plan", "architect", [0, 1], JSON.stringify({ criteria: [{ id: "AC-1", description: "Authorized export", checks: ["repo/test"] }], checks: ["repo/test"], preflight: ["repo/preflight"] })],
      ["implementation-plan", "implementation-plan", "architect", [0, 1, 2], JSON.stringify(plan)],
      ["review-report", "spec-review", "reviewer", [0, 1, 2, 3], "Coherent proposal; human decisions remain explicit."],
    ] as const) {
      const name = `${type}-${generation}`;
      const run = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
        metadata: { name: `run-${name}`, namespace: "default", ownerReferences: [ownerRef(wi)] },
        spec: { workItemRef: { name: "item" }, agentRef: { name: author }, stage, step: type, skillRefs: [],
          inputs: inputs.map((index) => ({ name: artifacts[index].spec.artifactTypeRef.name })), outputs: [{ name: type }] },
        status: { phase: "Succeeded", executor: "llm", result: { outcome: type === "review-report" ? "approve" : undefined },
          provenance: { executor: "llm", definitions: {}, inputs: Object.fromEntries(inputs.map((index) =>
            [artifacts[index].metadata.name, artifacts[index].metadata.resourceVersion!])), contexts: { "planning-intent": planningIntent(wi) } } } });
      artifacts.push(await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
        metadata: { name, namespace: "default", ownerReferences: [ownerRef(wi)] },
        spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: type }, content, format: "json",
          producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: { name: author } } } }));
    }
    return artifacts;
  }
  async function openReview() {
    const wi = await item();
    const compiled = await compiler.compile(wi.spec.workflowRef!, "default");
    const stage = compiled.stage("spec-review")!;
    const decision = await gates.get("verification-plan-review")!.evaluate({ workItem: wi, stage, gate: stage.gate! });
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") throw new Error(JSON.stringify(decision));
    const approval = await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval",
      metadata: { name: `approval-${generation}`, namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, stage: "spec-review", approvers: [], verification: decision.verification } });
    const fresh = await item();
    await store.updateStatus({ ...fresh, status: { ...fresh.status!, phase: "AwaitingApproval", stage: "spec-review",
      blockedBy: { kind: "Approval", name: approval.metadata.name }, restartHandled: fresh.spec.restart?.id } });
    return approval;
  }
  async function revise(action: PlanningRevisionInput["action"], requestId: string, extra: Partial<PlanningRevisionInput> = {}) {
    return planning.revise(p, "item", { action, requestId, revision: (await planning.inspect(p, "item")).revision, ...extra });
  }
  async function regenerate(plan = document) {
    await controller.reconcile(keyOf(await item()));
    await seed(plan);
    return openReview();
  }
  return { db, store, compiler, planning, verification, workflow, item, controller, seed, openReview, revise, regenerate, clock, redactor };
}

test("plan edits preserve originals, invalidate approval and regenerate requirements with idempotent optimistic requests", async () => {
  const f = await fixture();
  try {
    const original = await f.seed();
    const approval = await f.openReview();
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    await f.verification.validate(approval, "approve");
    const input: PlanningRevisionInput = { action: "revise", requestId: "edit-1",
      revision: (await f.planning.inspect(p, "item")).revision, context: "Keep private fields out. secret-value",
      draft: { ...document, scope: "CSV only; never export private fields." }, feedback: "Preserve the privacy constraint." };
    const saved = await f.planning.revise(p, "item", input);
    assert.equal(saved.spec.restart?.stage, "spec");
    assert.match(saved.spec.context!, /\[REDACTED\]/);
    assert.equal(saved.spec.planning?.draft?.scope, input.draft?.scope);
    const retried = await f.planning.revise(p, "item", input);
    assert.equal(retried.spec.restart?.id, saved.spec.restart?.id);
    await assert.rejects(f.planning.revise(p, "item", { ...input, feedback: "different" }), /different input/);
    await assert.rejects(f.verification.validate(approval, "approve"), /current context|revision/);
    await assert.rejects(f.planning.revise(p, "item", { ...input, requestId: "stale" }), /plan changed/);
    assert.equal((await f.store.get<Artifact>("Artifact", "default", original[3].metadata.name))?.spec.content, JSON.stringify(document));
    const revised = { ...document, scope: input.draft!.scope };
    const next = await f.regenerate(revised);
    assert.ok((await f.store.get<Artifact>("Artifact", "default", original[3].metadata.name))?.metadata.labels?.[LABEL_SUPERSEDED]);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.document?.scope, revised.scope);
    assert.equal(workspace.previous?.scope, document.scope);
    assert.equal(next.spec.decision, undefined, "saving and regeneration never approve");
    await f.verification.validate(next, "approve");
    await assert.rejects(f.verification.validate(approval, "approve"), /stale/);
  } finally { f.db.close(); }
});

test("submitted answers remain directly editable and changed decision semantics require fresh answers, not reopening", async () => {
  const f = await fixture();
  try {
    const plan = { ...document, decisions: [required] };
    await f.seed(plan);
    const approval = await f.openReview();
    assert.equal((await f.planning.inspect(p, "item")).ready, false);
    await assert.rejects(f.verification.validate(approval, "approve"), /required planning decision/);
    await assert.rejects(f.revise("decisions", "empty", { answers: {} }), /at least one/);
    await f.revise("decisions", "answers-1", { answers: { "sensitive-data": "Exclude" } });
    assert.equal((await f.item()).spec.planning?.batchSubmitted, true);
    const next = await f.regenerate({ ...plan, decisions: [{ ...required, options: ["Include", "Exclude"] }] });
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    await f.verification.validate(next, "approve");
    await f.revise("decisions", "answers-2", { answers: { "sensitive-data": "Include" } });
    await assert.rejects(f.verification.validate(next, "approve"), /current context|revision|stale/);
    const corrected = await f.regenerate(plan);
    assert.equal((await f.planning.inspect(p, "item")).decisions[0].answer, "Include");
    await f.verification.validate(corrected, "approve");
    await f.revise("revise", "new-scope", { feedback: "Reconsider tenant scope." });
    const changed = { ...document, decisions: [{ ...required, question: "Include all tenants' personal data?" }] };
    const newApproval = await f.regenerate(changed);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.batchSubmitted, true);
    assert.equal(workspace.decisions[0].answer, undefined, "changed question cannot reuse an old answer");
    assert.equal(workspace.ready, false);
    assert.match(workspace.issues.join(" "), /Answer 1 required planning decision/);
    assert.doesNotMatch(workspace.issues.join(" "), /reopen/i);
    await assert.rejects(f.verification.validate(newApproval, "approve"), /required planning decision/);
    await f.revise("decisions", "answers-3", { answers: { "sensitive-data": "Exclude" } });
    const fresh = await f.regenerate(changed);
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    assert.equal(fresh.spec.decision, undefined, "answering never approves the regenerated proposal");
    await f.verification.validate(fresh, "approve");
    assert.equal((await f.store.list("Clarification")).length, 0, "decision submission never starts a clarification interview");
  } finally { f.db.close(); }
});

test("new required decisions accept a direct consolidated submission while preserving previous answers and retry safety", async () => {
  const f = await fixture();
  try {
    const plan = { ...document, decisions: [required] };
    await f.seed(plan);
    await f.openReview();
    await f.revise("decisions", "initial-answers", { answers: { "sensitive-data": "Exclude" } });
    const additional = { ...required, id: "export-access", question: "Who can request an export?",
      options: ["Tenant admins", "All tenant users"], recommendation: "Tenant admins", rationale: "Defines the access policy." };
    const revised = { ...plan, decisions: [required, additional] };
    const approval = await f.regenerate(revised);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.batchSubmitted, true);
    assert.equal(workspace.canRevise, true);
    assert.equal(workspace.ready, false);
    assert.equal(workspace.decisions[0].answer, "Exclude");
    assert.equal(workspace.decisions[1].answer, undefined);
    const input: PlanningRevisionInput = { action: "decisions", requestId: "additional-answers",
      revision: workspace.revision, answers: { "export-access": "Tenant admins" } };
    const saved = await f.planning.revise(p, "item", input);
    const retried = await f.planning.revise(p, "item", input);
    assert.equal(retried.spec.restart?.id, saved.spec.restart?.id);
    assert.equal(saved.spec.planning?.answers["sensitive-data"].answer, "Exclude");
    await assert.rejects(f.planning.revise(p, "item", { ...input, answers: { "export-access": "All tenant users" } }), /different input/);
    await assert.rejects(f.verification.validate(approval, "approve"), /current context|revision|stale/);
    const fresh = await f.regenerate(revised);
    const ready = await f.planning.inspect(p, "item");
    assert.deepEqual(ready.decisions.map((decision) => decision.answer), ["Exclude", "Tenant admins"]);
    assert.equal(ready.ready, true);
    assert.equal(fresh.spec.decision, undefined);
    await f.verification.validate(fresh, "approve");
    assert.equal((await f.store.list("Clarification")).length, 0);
  } finally { f.db.close(); }
});

test("questions from different agents form one sheet and partial submissions cannot omit required answers", async () => {
  const f = await fixture();
  try {
    await f.seed({ ...document, decisions: [required] });
    const wi = await f.item();
    await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "triage-question", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "triager" }, stage: "triage", step: "triage", inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Succeeded", result: { questions: ["Which customers may export?"] } } });
    await f.openReview();
    const sheet = await f.planning.inspect(p, "item");
    assert.equal(sheet.decisions.length, 2);
    await assert.rejects(f.revise("decisions", "partial", { answers: { "sensitive-data": "Exclude" } }), /every unresolved required decision/);
    assert.equal((await f.item()).spec.planning, undefined);
    await f.revise("decisions", "all-answers", { answers: Object.fromEntries(sheet.decisions.map((decision) => [decision.id, "Only authorized tenant users; exclude private fields"])) });
    await f.regenerate({ ...document, decisions: [required] });
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
  } finally { f.db.close(); }
});

test("planning questions are deferred; malformed review stops durably without Clarification or re-asking", async () => {
  const f = await fixture();
  try {
    const wi = await f.item();
    const workflow = await f.compiler.compile(wi.spec.workflowRef!, "default");
    assert.equal(await f.planning.deferQuestions(wi, workflow.stage("spec")!), true);
    assert.equal(await f.planning.deferQuestions(wi, workflow.stage("implement")!), false);
    await f.store.updateStatus({ ...wi, status: { phase: "Running", stage: "triage", round: 1, step: 0 } });
    await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "item-triage-0-r1", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "triager" }, stage: "triage", step: "triage", inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Succeeded", result: { questions: ["Which customers?"] } } });
    await f.controller.reconcile(keyOf(wi));
    assert.equal((await f.item()).status?.step, 1);
    const fresh = await f.item();
    await f.store.updateStatus({ ...fresh, status: { phase: "Running", stage: "spec-review", round: 2 } });
    await f.controller.reconcile(keyOf(wi));
    await f.controller.reconcile(keyOf(wi));
    const stopped = await f.item();
    assert.equal(stopped.status?.phase, "Blocked");
    assert.equal(stopped.status?.blockedBy, undefined);
    assert.equal(stopped.status?.conditions?.find((condition) => condition.type === "Blocked")?.reason, "HumanAttentionRequired");
    assert.match(stopped.status?.message ?? "", /validation-plan/);
    assert.equal((await f.store.list("Clarification")).length, 0);
    assert.equal((await f.planning.inspect(p, "item")).canRevise, true);
  } finally { f.db.close(); }
});

test("real exact-input and independent review provenance is required, including after context edits", async (t) => {
  for (const variant of ["simulated", "stale-context", "stale-input", "same-reviewer", "replay"] as const) {
    await t.test(variant, async () => {
      const f = await fixture();
      try {
        await f.seed();
        const approval = await f.openReview();
        const run = (await f.store.get<AgentRun>("AgentRun", "default", variant === "same-reviewer" ? "run-review-report-1" : "run-implementation-plan-1"))!;
        if (variant === "same-reviewer") await f.store.update({ ...run, spec: { ...run.spec, agentRef: { name: "architect" } } });
        else if (variant === "replay") await f.store.update({ ...run, spec: { ...run.spec, replayOf: { name: "old-run" } } });
        else if (variant === "stale-context") {
          const item = await f.item();
          await f.store.update({ ...item, spec: { ...item.spec, context: "Changed after review" } });
        } else await f.store.updateStatus({ ...run, status: { ...run.status!,
          ...(variant === "simulated" ? { executor: "simulated" } : {}),
          ...(variant === "stale-input" ? { provenance: { ...run.status!.provenance!, inputs: {} } } : {}),
        } });
        await assert.rejects(f.verification.validate(approval, "approve"), /current|stale|independent|not available|unresolved/);
        assert.equal((await f.planning.inspect(p, "item")).ready, false);
      } finally { f.db.close(); }
    });
  }
});

test("unresolved AI plan review findings never veto the human: approving needs an explicit reason", async () => {
  const f = await fixture();
  try {
    await f.seed();
    const approval = await f.openReview();
    const review = (await f.store.get<AgentRun>("AgentRun", "default", "run-review-report-1"))!;
    await f.store.updateStatus({ ...review, status: { ...review.status!, result: { outcome: "changes-requested" } } });
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, true);
    assert.equal(workspace.reviewFindings, true);
    await assert.rejects(f.verification.validate(approval, "approve"), /AI plan review still requests changes/);
    await f.verification.validate(approval, "approve", "Accepting: findings are about unread files, which U2 reads first");
  } finally { f.db.close(); }
});

test("revision boundaries exclude active jobs/publication and explicit disposition is applied only by the controller", async (t) => {
  for (const variant of ["agent", "check", "publication"] as const) {
    await t.test(variant, async () => {
      const f = await fixture();
      try {
        await f.seed(); await f.openReview();
        const wi = await f.item();
        const metadata = { name: "active", namespace: "default", ownerReferences: [ownerRef(wi)] };
        if (variant === "agent") await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata,
          spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, stage: "implement", step: "write", inputs: [], outputs: [], skillRefs: [] } });
        if (variant === "check") await f.store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun", metadata,
          spec: { workItemRef: { name: "item" }, workItemUid: wi.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: "ws",
            repositoryRef: { name: "repo" }, repositoryVersion: "1", check: "test", command: "tests", timeoutMs: 1000,
            snapshot: "tree", environment: { runtime: "fake", profileVersion: "1" }, requestedBy: "human", requestFingerprint: "1" } });
        if (variant === "publication") await f.store.create<OutboxMessage>({ apiVersion: API_VERSION, kind: "OutboxMessage", metadata, spec: { action: "open-pull-request", payload: {} } });
        assert.equal((await f.planning.inspect(p, "item")).canRevise, false);
        await assert.rejects(f.revise("revise", "unsafe"), /safe human stop/);
      } finally { f.db.close(); }
    });
  }
  for (const action of ["defer", "reject"] as const) {
    const f = await fixture();
    try {
      await f.seed(); await f.openReview();
      const updated = await f.revise(action, `human-${action}`);
      assert.equal(updated.status?.phase, "AwaitingApproval", "command cannot write controller status");
      await f.controller.reconcile(keyOf(updated));
      assert.equal((await f.item()).status?.phase, "Closed");
      assert.equal((await f.planning.inspect(p, "item")).disposition, action === "defer" ? "deferred" : "rejected");
      assert.equal((await f.store.list("OutboxMessage")).length, 0);
    } finally { f.db.close(); }
  }
});

test("legacy workflows retain their verified contract and ordinary question behavior", async () => {
  const f = await fixture();
  try {
    const workflow = await f.store.get<Workflow>("Workflow", "factory-system", "planned");
    await f.store.update({ ...workflow!, spec: { ...workflow!.spec, planning: undefined } });
    await f.seed();
    const wi = await f.item();
    assert.equal((await f.planning.inspect(p, "item")).enabled, false);
    assert.equal(await f.planning.binding(wi), undefined);
    await f.planning.assertReady(wi);
    assert.equal(await f.planning.deferQuestions(wi, (await f.compiler.compile(wi.spec.workflowRef!, "default")).stage("spec")!), false);
    await assert.rejects(f.planning.revise(p, "item", { action: "revise", requestId: "legacy", revision: "displayed" }), /does not enable/);
    const contract = await f.verification.plan(wi, false);
    assert.ok(contract.fingerprint);
  } finally { f.db.close(); }
});

test("a malformed historical proposal is reported without making a fresh valid plan unapprovable", async () => {
  const f = await fixture();
  try {
    const old = await f.seed();
    await f.store.update({ ...old[3], spec: { ...old[3].spec, content: "incomplete old output" } });
    await f.seed();
    const approval = await f.openReview();
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, true);
    assert.match(workspace.historyError ?? "", /Previous proposal cannot be compared/);
    await f.verification.validate(approval, "approve");
  } finally { f.db.close(); }
});

test("a required decision's advisory recommendation may add commentary; an optional default must be an exact option", () => {
  const sections = { outcome: "o", scope: "s", approach: "a", delivery: "d", acceptance: "c", risks: "r" };
  const decision = { id: "OD-1", question: "Reject deletions of referenced definitions?", options: ["(a) Reject", "(b) Accept"],
    recommendation: "(a) Reject. This matches the existing remove() behaviour.", rationale: "Safety", required: true };
  const parsed = parsePlanningDocument(JSON.stringify({ ...sections, decisions: [decision] }));
  assert.equal(parsed.decisions[0].recommendation, decision.recommendation);
  assert.throws(() => parsePlanningDocument(JSON.stringify({ ...sections, decisions: [{ ...decision, required: false }] })),
    /recommended default must be one of its displayed options/);
});

test("upstream questions citing an existing decision ID fold into that decision instead of adding blockers", async () => {
  const document = parsePlanningDocument(JSON.stringify({ outcome: "o", scope: "s", approach: "a", delivery: "d", acceptance: "c", risks: "r",
    decisions: [{ id: "OD-1", question: "Reject deletions of referenced definitions?", options: ["Reject", "Accept"], rationale: "Safety", required: true }] }));
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const run = { spec: { stage: "spec", agentRef: { name: "product-owner" } },
    status: { result: { questions: ["OD-1: should deletion be rejected (a) or accepted (b)?", "OD-9: an unknown decision?", "Which namespace owns it?"] } } } as AgentRun;
  const decisions = (service as unknown as { decisions(item: WorkItem, d: typeof document, runs: AgentRun[], stages: Set<string>): { id: string }[] })
    .decisions({ spec: {} } as WorkItem, document, [run], new Set(["spec"]));
  assert.deepEqual(decisions.map((d) => d.id.startsWith("question-") ? "question" : d.id), ["OD-1", "question", "question"]);
});
