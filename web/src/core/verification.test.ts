import assert from "node:assert/strict";
import { originAuthorized } from "./checks/origin.ts";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Approval, Artifact, CheckOutcome, CheckRun, Clarification, Repository, WorkItem, Workflow, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { ANONYMOUS, SandboxUnavailableError, type CheckRunScheduler, type ExecutionContext, type GateContext, type GateDecision } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { VerificationService, gapCriterion } from "./verification/service.ts";
import { verificationPolicyGaps } from "./model/verification-policy.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { createAgentRunController } from "./runtime/controllers/agentrun.ts";
import { Registry } from "./registry/registry.ts";
import type { GateEvaluator } from "./ports/index.ts";
import { checkDefinitionVersion } from "./checks/definition-version.ts";

async function fixture(preparation = false, scan?: boolean, flakyWaive = false) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-13T12:00:00Z") };
  const store = new SqliteStore(db, clock);
  const policy = { planningStage: "validation-plan", reviewStage: "spec-review", preflightStage: "preflight",
    verifyStage: "verify", implementationStage: "implement", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 1000,
    ...(preparation ? { preparationStage: "code-review" } : {}) };
  await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "verified", namespace: "factory-system" },
    spec: { verification: policy, phases: [{ name: "construction", stages: [
      { name: "validation-plan" }, { name: "spec-review", gate: { type: "verification-plan-review" } },
      { name: "preflight", gate: { type: "verified-checks" } }, { name: "implement", steps: [{ name: "write", agentRef: { name: "developer" } }] },
      { name: "code-review", gate: { type: "verification-candidate-review" } }, { name: "verify", gate: { type: "verified-checks" } },
      { name: "ship", publish: { pullRequest: { draft: true } }, gate: { type: "human-approval" } },
    ] }] } });
  const repo = await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
    spec: { checks: { preflight: "prepare", build: "build", test: { command: "tests", resultFormat: "go-test-json" }, ...(scan === undefined ? {} : { "manual-acceptance": "scan" }) },
      verification: { requiredChecks: ["build", "test", "manual-acceptance"], preflightChecks: ["preflight"],
        ...(preparation ? { preparationChecks: ["build"] } : {}), waivableChecks: ["manual-acceptance", ...(flakyWaive ? ["test"] : [])],
        ...(scan ? { autoWaive: [{ check: "manual-acceptance", when: "pre-existing" as const, followUp: "finding" as const }] } : {}),
        ...(flakyWaive ? { autoWaive: [{ check: "test", when: "flaky" as const }] } : {}) } } });
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
    spec: { title: "Verify", sourceRef: { name: "manual" }, repositoryRefs: [{ name: "repo" }], workflowRef: { name: "verified" } },
    status: { phase: "Running", stage: "spec-review", round: 1 } });
  const workspace = await store.create<Workspace>({ apiVersion: API_VERSION, kind: "Workspace",
    metadata: { name: "ws", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" },
    status: { phase: "Ready", path: "/fake" } });
  const spec = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "spec", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { artifactTypeRef: { name: "spec" }, workItemRef: { name: "item" }, format: "markdown", content: "AC-1: preserve accepted behavior" } });
  await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata: { name: "planner", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, agentRef: { name: "architect" }, skillRefs: [], stage: "validation-plan", step: "plan", inputs: [{ name: "spec" }], outputs: [{ name: "validation-plan" }] },
    status: { phase: "Succeeded", executor: "tool-loop", provenance: { executor: "tool-loop", definitions: {}, inputs: { spec: spec.metadata.resourceVersion! } } } });
  const plan = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "plan", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { artifactTypeRef: { name: "validation-plan" }, workItemRef: { name: "item" }, producedBy: { agentRunRef: { name: "planner" }, agentRef: { name: "architect" } },
      format: "json", content: JSON.stringify({ criteria: [{ id: "AC-1", description: "Preserve behavior", checks: ["repo/build", "repo/test", "repo/manual-acceptance"] }],
        checks: ["repo/build", "repo/test", "repo/manual-acceptance"], preflight: ["repo/preflight"] }) } });
  let tree = "tree-a";
  const snapshots = { fingerprint: async () => tree };
  const scheduler: CheckRunScheduler = {
    submit: async (request) => store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun",
      metadata: { name: `check-${request.workflow.stage}-${request.check}-${request.workflow.attempt}`, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: workspace.metadata.uid!,
        repositoryRef: { name: "repo" }, repositoryVersion: checkDefinitionVersion(repo), check: request.check, command: request.check,
        timeoutMs: 1000, snapshot: tree, environment: { runtime: "fake", version: "1", profileVersion: "default" }, requestedBy: "gate",
        requestFingerprint: request.requestId, workflow: request.workflow } }),
  };
  const compiler = new DefaultWorkflowCompiler(store);
  const events = new StoreEventRecorder(store);
  const service = new VerificationService({ namespace: "default", reader: store, writer: store, compiler, snapshots,
    scheduler, events, clock, redactor: { redact: (text) => text },
    environments: { select: async () => ({ environment: { runtime: "fake", health: async () => ({ runtime: "fake", available: true, isolation: "container" }), prepare: async () => { throw new Error("never execute"); } },
      health: { runtime: "fake", version: "1", available: true, isolation: "container" }, candidates: [] }), refresh: async () => {} } });
  const current = async () => (await store.get<WorkItem>("WorkItem", "default", "item"))!;
  async function context(stage: string): Promise<GateContext> {
    const wi = await current();
    const compiled = await compiler.compile(wi.spec.workflowRef!, "default");
    const st = compiled.stage(stage)!;
    return { workItem: wi, stage: st, gate: st.gate! };
  }
  async function approve(stage: string) {
    const ctx = await context(stage);
    const gate = service.gates.find((g) => g.type === ctx.gate.type)!;
    const decision = await gate.evaluate(ctx);
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") throw new Error("expected approval");
    const a = await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval",
      metadata: { name: `approval-${stage}-${tree}`, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, stage, approvers: [], verification: decision.verification } });
    await service.validate(a, "approve", "Explicit reviewed exception");
    return store.update<Approval>({ ...a, spec: { ...a.spec, decision: "approve", decidedBy: "human", comment: "Explicit reviewed exception" } });
  }
  async function finish(run: CheckRun, outcome: CheckOutcome) {
    return store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed", outcome, finalSnapshot: run.spec.snapshot,
      // A real runner records what it saw; the blocked question must carry it (a preflight stops at the first
      // unmet prerequisite without printing anything of its own).
      message: `${run.spec.check}: ${outcome} (exit 1 in 24 ms)`,
      ...(outcome === "Passed" ? {} : { outputTail: "go version go1.27.1 linux/amd64\n/usr/bin/make" }),
      logsIncomplete: outcome !== "Passed", finishedAt: "2026-11-13T11:00:00Z" } });
  }
  const gate = service.gates.find((g) => g.type === "verified-checks")!;
  async function runStage(stage: string) { return gate.evaluate(await context(stage)); }
  async function seedPass(check: string, purpose: "preflight" | "verification", stage: string) {
    const contract = await service.plan(await current(), true);
    return finish(await scheduler.submit({ workItem: await current(), workspace, repository: repo, check, requestedBy: "fixture",
      requestId: `seed-${check}`, workflow: { stage, round: 1, purpose, planFingerprint: contract.fingerprint, attempt: 1 } }), "Passed");
  }
  return { db, store, service, item, repo, plan, spec, current, compiler, context, approve, finish, runStage, seedPass,
    snapshots, scheduler, workspace, clock, events, tree: (value: string) => { tree = value; } };
}

test("active checks wait before snapshot validation or resuming an answered clarification", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    await f.runStage("verify");
    f.snapshots.fingerprint = async () => { throw new Error("must not fingerprint a moving workspace"); };
    assert.equal((await f.runStage("verify")).action, "wait");
    const clarification = await f.store.create({ apiVersion: API_VERSION, kind: "Clarification",
      metadata: { name: "old-drift", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, stage: "verify", questions: ["Candidate changed"], answers: ["yes"] } });
    const current = await f.current();
    await f.store.updateStatus({ ...current, status: { ...current.status!, phase: "Blocked", blockedBy: { kind: "Clarification", name: clarification.metadata.name } } });
    const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
      compiler: f.compiler, gates: new Registry<GateEvaluator>(), outbox: { enqueue: async () => { throw new Error("no publication"); } }, workspaces: { supports: () => false }, stagePolicy: f.service, resumptionPolicy: f.service });
    const waiting = await controller.reconcile(keyOf(current));
    assert.ok(waiting?.requeueAfterMs);
    assert.equal((await f.current()).status?.round, 1, "an answer cannot race a running check into a new agent round");
  } finally { f.db.close(); }
});

test("candidate drift returns through the controller to fresh human review with a separate bounded budget", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    f.tree("generated");
    const gates = new Registry<GateEvaluator>();
    for (const gate of f.service.gates) gates.register(gate.type, gate);
    const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
      compiler: f.compiler, gates, outbox: { enqueue: async () => { throw new Error("no publication"); } }, workspaces: { supports: () => false }, stagePolicy: f.service });
    await controller.reconcile(keyOf(wi));
    assert.equal((await f.current()).status?.stage, "code-review");
    assert.equal((await f.current()).status?.retries?.["candidate-drift"], 1);
    await controller.reconcile(keyOf(wi));
    assert.equal((await f.current()).status?.phase, "AwaitingApproval");
    assert.equal((await f.store.list("Clarification")).length, 0);
    const current = await f.current();
    await f.store.updateStatus({ ...current, status: { ...current.status!, phase: "Running", stage: "verify", retries: { "candidate-drift": 2 } } });
    assert.equal((await f.service.beforeStage(await f.current(), (await f.context("verify")).stage)).action, "block");
  } finally { f.db.close(); }
});

test("candidate drift targets the policy-bound review, not unrelated candidate gates", async () => {
  for (const preparation of [false, true]) {
    const f = await fixture(preparation);
    try {
      const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "verified"))!;
      await f.store.update({ ...workflow, spec: { ...workflow.spec, phases: workflow.spec.phases.map(phase => ({
        ...phase, stages: [
          { name: "unrelated-review", gate: { type: "verification-candidate-review" } },
          ...phase.stages.flatMap(stage => preparation && stage.name === "implement" ? [
            stage, { name: "additional-review", gate: { type: "verification-candidate-review" } },
          ] : [stage]),
        ],
      })) } });
      await f.approve("spec-review");
      await f.seedPass("preflight", "preflight", "preflight");
      assert.deepEqual(await f.service.beforeStage(await f.current(), (await f.context("verify")).stage),
        { action: "goto", stage: "code-review", retryOf: "candidate-drift" });
    } finally { f.db.close(); }
  }
});

test("preparation precedes review, records generated code and never substitutes for final verification", async () => {
  const f = await fixture(true);
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "code-review" } });
    const stage = (await f.context("code-review")).stage;
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "wait");
    const job = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
    assert.equal(job.spec.workflow?.purpose, "preparation");
    f.tree("generated");
    await f.store.updateStatus({ ...job, status: { phase: "Completed", outcome: "NotVerified", executionOutcome: "Passed", exitCode: 0,
      logsIncomplete: false, finalSnapshot: "generated", finishedAt: "2026-11-13T11:00:00Z" } });
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "advance");
    await f.approve("code-review");
    assert.match((await f.service.check(await f.current()))!, /missing\/stale evidence/);
    assert.equal((await f.store.list<CheckRun>("CheckRun")).filter(r => r.spec.check === "build" && r.status?.outcome === "Passed").length, 0);
  } finally { f.db.close(); }
});

test("exhausted preparation explains every attempt: the files a check rewrote, that the cause repeats, and what to do", async () => {
  const f = await fixture(true);
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "code-review" } });
    const stage = (await f.context("code-review")).stage;
    for (let attempt = 1; attempt <= 2; attempt++) {
      assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "wait");
      const job = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
      // The check regenerated a file and was restored: the candidate is unchanged, the result is not evidence.
      await f.store.updateStatus({ ...job, status: { phase: "Completed", outcome: "NotVerified", executionOutcome: "Passed", exitCode: 0,
        logsIncomplete: false, finalSnapshot: "regenerated", finishedAt: "2026-11-13T11:00:00Z", durationMs: 70_000,
        message: "build: Passed (exit 0 in 70000 ms); check modified the workspace: 1 file: modified svc/server.gen.go (+239/−219) (restored)",
        workspaceChanges: { total: 1, files: [{ path: "svc/server.gen.go", change: "modified", added: 239, deleted: 219 }] } } });
    }
    const decision = await f.service.beforeStage(await f.current(), stage);
    assert.equal(decision.action, "block");
    const question = decision.action === "block" ? decision.questions[0] : "";
    assert.match(question, /produced no usable result in 2 attempt\(s\)/);
    assert.match(question, /modified svc\/server\.gen\.go \(\+239\/−219\)/);
    assert.match(question, /Every attempt ended the same way/);
    assert.match(question, /What to do:.*Commit the regenerated files/);
    assert.match(question, /restart the code-review stage/);
  } finally { f.db.close(); }
});

test("run_check normalizes repository/workspace and canonical/bare check identities before deduplication", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    const run = await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "verifier", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, stage: "verify", step: "verify", agentRef: { name: "verifier" }, inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Running" } });
    const ctx: ExecutionContext = { run, workItem: await f.current(), agent: { apiVersion: API_VERSION, kind: "Agent",
      metadata: { name: "verifier" }, spec: { role: "Verifier" }, body: "" }, skills: [], inputs: [], approvals: [], clarifications: [],
      repositories: [f.repo], workspaces: [f.workspace], sections: [],
      transcript: { ref: { id: "verifier", namespace: "default" }, record: async () => {} } };
    const submissions: Parameters<CheckRunScheduler["submit"]>[0][] = [];
    let receipt: CheckRun | undefined;
    const submit = f.scheduler.submit;
    f.scheduler.submit = async request => { submissions.push(request); return receipt ??= await submit(request); };
    const first = await f.service.run(ctx, { workspace: "repo", check: "repo/test", requestId: "stable" });
    const retry = await f.service.run(ctx, { workspace: "ws", check: "test", requestId: "stable" });
    assert.equal(first.metadata.uid, retry.metadata.uid);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(submissions[0].check, "test");
    assert.equal(submissions[0].workspace.metadata.name, "ws");
    await assert.rejects(f.service.run(ctx, { workspace: "missing", check: "test", requestId: "other" }), /valid.*ws/i);
    await assert.rejects(f.service.run(ctx, { workspace: "repo", check: "foreign/test", requestId: "other" }), /repository|approved plan/);
    await assert.rejects(f.service.run({ ...ctx, run: { ...run, spec: { ...run.spec, tools: [] } } },
      { workspace: "repo", check: "test", requestId: "denied" }), /step's tool restrictions/);
    await assert.rejects(f.service.run({ ...ctx, run: { ...run, spec: { ...run.spec,
      recovery: { mode: "diagnosis" } as NonNullable<AgentRun["spec"]["recovery"]> } } },
      { workspace: "repo", check: "test", requestId: "diagnostic" }), /scoped recovery authorization/);
  } finally { f.db.close(); }
});

test("agent check logs page complete redacted content and reject foreign ownership", async () => {
  const f = await fixture();
  try {
    const item = await f.store.updateStatus<WorkItem>({ ...f.item, status: { ...f.item.status!, stage: "implement" } });
    const run = await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "developer", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, stage: "implement", step: "write", agentRef: { name: "developer" }, inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Running" } });
    const check = await f.scheduler.submit({ workItem: f.item, workspace: f.workspace, repository: f.repo, check: "test",
      requestId: "log", requestedBy: "test", workflow: { stage: "implement", round: 1, purpose: "verification", planFingerprint: "p", attempt: 1 } });
    await f.store.updateStatus<CheckRun>({ ...check, status: { phase: "Completed", logRef: { namespace: "default", id: "log" }, logsIncomplete: false } });
    const service = new VerificationService({ namespace: "default", reader: f.store, writer: f.store, compiler: f.compiler,
      snapshots: f.snapshots, scheduler: f.scheduler, events: f.events, clock: f.clock,
      environments: {} as never, redactor: { redact: (text) => text.replaceAll("SECRET", "[redacted]") },
      logs: { read: async (_ref, options) => options?.afterSeq ? [] : [{ seq: 1, at: "", role: "note",
        author: { type: "system", id: "check" }, content: `${"x".repeat(5998)}SECRETend` }] } });
    const ctx = { workItem: item, run } as ExecutionContext;
    const first = await service.read(ctx, { checkRun: check.metadata.name });
    assert.ok(!first.content.includes("SECRET"));
    const second = await service.read(ctx, { checkRun: check.metadata.name, ...first.next! });
    assert.ok((first.content + second.content).includes("[redacted]end"));
    await assert.rejects(service.read({ ...ctx, workItem: { ...f.item, metadata: { ...f.item.metadata, uid: "other" } } },
      { checkRun: check.metadata.name }), /not owned/);
  } finally { f.db.close(); }
});

test("review binds the exact specification, plan and policy; omission and simulated planning cannot pass", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.plan(await f.current(), true), /fresh human approval/);
    const approval = await f.approve("spec-review");
    await f.service.plan(await f.current(), true);
    const old = await f.service.plan(await f.current(), false);
    await f.store.create<Approval>({ ...approval, metadata: { name: "fresh-review", namespace: "default", ownerReferences: [ownerRef(f.item)] },
      spec: { ...approval.spec, decision: undefined, decidedBy: undefined, comment: undefined } });
    await assert.rejects(f.service.plan(await f.current(), true), /fresh human approval/);
    await f.store.update({ ...f.spec, spec: { ...f.spec.spec, content: "Changed acceptance criteria" } });
    await assert.rejects(f.service.plan(await f.current(), true), /current specification/);
    assert.ok(old.fingerprint);
  } finally { f.db.close(); }
  const g = await fixture();
  try {
    await g.store.update({ ...g.plan, spec: { ...g.plan.spec, content: JSON.stringify({ criteria: [{ id: "AC", description: "weak", checks: ["repo/build"] }], checks: ["repo/build"], preflight: ["repo/preflight"] }) } });
    await assert.rejects(g.service.plan(await g.current(), false), /omits required check/);
    const planner = (await g.store.get<AgentRun>("AgentRun", "default", "planner"))!;
    await g.store.updateStatus({ ...planner, status: { ...planner.status!, executor: "simulated" } });
    await assert.rejects(g.service.plan(await g.current(), false), /current real validation-plan/);
  } finally { g.db.close(); }
});

test("a workflow-only change asks for in-place plan re-confirmation that keeps existing evidence (ADR-0054)", async () => {
  const f = await fixture();
  try {
    const original = await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, phase: "Running", stage: "implement", step: 0, round: 3 } });
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "verified"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec, phases: workflow.spec.phases.map((phase) => ({ ...phase,
      stages: phase.stages.map((stage) => stage.name === "ship" ? { ...stage, gate: { ...stage.gate!, criteria: ["New release checklist"] } } : stage) })) } });
    await assert.rejects(f.service.plan(await f.current(), true), /fresh human approval/);
    const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
      compiler: f.compiler, gates: new Registry<GateEvaluator>(), outbox: { enqueue: async () => { throw new Error("no publication"); } },
      workspaces: { supports: () => false }, stagePolicy: f.service, planReconfirmation: f.service });
    await controller.reconcile(keyOf(wi));
    const waiting = await f.current();
    assert.equal(waiting.status?.phase, "AwaitingApproval", "no unanswerable clarification");
    assert.equal((await f.store.list("Clarification")).length, 0);
    const approval = (await f.store.get<Approval>("Approval", "default", waiting.status!.blockedBy!.name))!;
    assert.equal(approval.spec.stage, "implement");
    assert.equal(approval.spec.verification?.rebinds, original.spec.verification?.fingerprint);
    assert.match(approval.spec.criteria!.join(" "), /re-confirmation/);
    await f.service.validate(approval, "approve");
    await f.store.update<Approval>({ ...approval, spec: { ...approval.spec, decision: "approve", decidedBy: "human" } });
    assert.equal((await f.service.plan(await f.current(), true)).fingerprint, original.spec.verification?.fingerprint, "evidence bound to the approved plan stays valid");
    await controller.reconcile(keyOf(wi));
    assert.deepEqual([(await f.current()).status?.phase, (await f.current()).status?.stage, (await f.current()).status?.round], ["Running", "implement", 4]);
    await controller.reconcile(keyOf(wi));
    assert.equal((await f.store.list<AgentRun>("AgentRun")).filter((r) => r.spec.stage === "implement").length, 1, "construction resumes without spec-review");

    await f.store.update({ ...f.spec, spec: { ...f.spec.spec, content: "Changed acceptance criteria" } });
    assert.equal(await f.service.request(await f.current(), (await f.context("implement")).stage), undefined, "a changed plan needs real plan review");
  } finally { f.db.close(); }
});

test("legacy plan approvals are re-confirmed only when nothing was edited after the decision (ADR-0054)", async () => {
  const f = await fixture();
  try {
    const original = await f.approve("spec-review");
    const { content: _content, ...legacy } = original.spec.verification!;
    await f.store.update<Approval>({ ...original, spec: { ...original.spec, verification: legacy } });
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "verified"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec, phases: workflow.spec.phases.map((phase) => ({ ...phase,
      stages: phase.stages.map((stage) => stage.name === "ship" ? { ...stage, gate: { ...stage.gate!, criteria: ["New release checklist"] } } : stage) })) } });
    const stage = (await f.context("implement")).stage;
    const decision = await f.service.request(await f.current(), stage);
    assert.equal(decision?.action, "await-approval");
    const review = (await f.compiler.compile({ name: "verified" }, "default")).stage("spec-review")!;
    if (decision?.action === "await-approval") assert.deepEqual(decision.approvers, review.gate?.approvers ?? [], "the plan reviewers decide, not the current stage's");
    await f.store.update({ ...f.spec, spec: { ...f.spec.spec, content: "Edited in place after approval" } });
    assert.equal(await f.service.request(await f.current(), stage), undefined, "an in-place edit after the decision fails closed");
  } finally { f.db.close(); }
});

test("an unresolved base merge at the publish stage goes back to its conflict route before the publication guard (ADR-0054)", async () => {
  const f = await fixture();
  try {
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "verified"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec, phases: workflow.spec.phases.map((phase) => ({ ...phase,
      stages: phase.stages.map((stage) => stage.name === "ship" ? { ...stage, publish: { pullRequest: { draft: true, onConflict: { next: "implement", maxAttempts: 2 } } } } : stage) })) } });
    await f.approve("spec-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, phase: "Running", stage: "ship", step: 0, round: 7 } });
    const ws = (await f.store.get<Workspace>("Workspace", "default", "ws"))!;
    await f.store.updateStatus({ ...ws, status: { ...ws.status!, integration: { commit: "b".repeat(40), ref: "main", round: 5, conflicts: ["a.ts"], at: "2026-11-13T12:00:01Z" } } });
    const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
      compiler: f.compiler, gates: new Registry<GateEvaluator>(), outbox: { enqueue: async () => { throw new Error("must not publish a merge in progress"); } },
      workspaces: { supports: () => false }, stagePolicy: f.service, publicationGuard: f.service, publicationRecovery: f.service, planReconfirmation: f.service });
    assert.match(String(await f.service.check(await f.current())), /./, "the merged candidate is not publishable as is");
    await controller.reconcile(keyOf(wi));
    const routed = await f.current();
    assert.deepEqual([routed.status?.phase, routed.status?.stage, routed.status?.retries?.["base-conflict"]], ["Running", "implement", 1]);
    assert.equal((await f.store.list("Clarification")).length, 0, "no dead-end publication clarification");
  } finally { f.db.close(); }
});

test("misordered policies cannot turn the construction entry guard into a review bypass", async () => {
  const f = await fixture();
  try {
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "verified"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec,
      verification: { ...workflow.spec.verification!, reviewStage: "implement" } } });
    const decision = await f.service.beforeStage(await f.current(), (await f.context("implement")).stage);
    assert.equal(decision.action, "block");
    if (decision.action === "block") assert.match(decision.questions.join(" "), /verification stages must exist/);
  } finally { f.db.close(); }
});

test("rejecting a stale plan still returns to planning rather than requiring valid old evidence", async () => {
  const f = await fixture();
  try {
    const approval = await f.approve("spec-review");
    await f.store.update({ ...f.spec, spec: { ...f.spec.spec, content: "Revised acceptance criteria" } });
    const gate = f.service.gates.find((candidate) => candidate.type === "verification-plan-review")!;
    const decision = await gate.evaluateApproval(await f.context("spec-review"),
      { ...approval, spec: { ...approval.spec, decision: "reject" } });
    assert.deepEqual(decision, { action: "goto", stage: "validation-plan" });
  } finally { f.db.close(); }
});

test("stage entry cannot bypass human plan review or current same-environment preflight", async () => {
  const f = await fixture();
  try {
    const stage = (await f.context("implement")).stage;
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "block");
    await f.approve("spec-review");
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "wait", "a missing preflight is run, never skipped");
    const preflight = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
    assert.equal(preflight.spec.workflow?.purpose, "preflight");
    await f.finish(preflight, "Passed");
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "advance");
    const profileChangedRepo = await f.store.update({ ...f.repo, spec: { ...f.repo.spec, checks: { ...f.repo.spec.checks, preflight: "new prerequisites" } } });
    assert.ok(profileChangedRepo.metadata.resourceVersion !== f.repo.metadata.resourceVersion);
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "block");
  } finally { f.db.close(); }
});

test("infrastructure failures exhaust execution budget into durable attention without code retries", async () => {
  for (const outcome of ["TimedOut", "Cancelled", "SetupFailed", "Unavailable", "UnknownFailure"] as const) {
    const f = await fixture();
    try {
      await f.approve("spec-review");
      const wi = await f.current();
      await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "preflight" } });
      const gates = new Registry<GateEvaluator>();
      for (const gate of f.service.gates) gates.register(gate.type, gate);
      const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
        compiler: f.compiler, gates, outbox: { enqueue: async () => { throw new Error("must not publish"); } }, workspaces: { supports: () => false }, stagePolicy: f.service });
      for (let attempt = 0; attempt < 2; attempt++) {
        await controller.reconcile(keyOf(wi));
        const run = (await f.store.list<CheckRun>("CheckRun", { namespace: "default" })).at(-1)!;
        await f.finish(run, outcome);
      }
      await controller.reconcile(keyOf(wi));
      const blocked = await f.current();
      assert.equal(blocked.status?.phase, "Blocked", outcome);
      assert.equal(blocked.status?.blockedBy?.kind, "Clarification");
      assert.equal(blocked.status?.retries, undefined);
      assert.equal((await f.store.list<AgentRun>("AgentRun")).length, 1, "no speculative developer execution");
      // The question must be actionable: the outcome *and* the evidence the check itself produced.
      const [question] = (await f.store.list<Clarification>("Clarification", { namespace: "default" })).at(-1)!.spec.questions;
      assert.match(question, new RegExp(outcome), "the question names the outcome");
      assert.match(question, /\/usr\/bin\/make/, "the question carries the check's own output, not just the outcome");
      assert.match(question, /no code-fix retry was charged/, "and says that no code fix was blamed");
    } finally { f.db.close(); }
  }
});

test("runtime loss during preflight submission requests durable attention instead of crashing reconciliation", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    f.scheduler.submit = async () => { throw new SandboxUnavailableError("fake", "runtime stopped"); };
    const decision = await f.runStage("preflight");
    assert.equal(decision.action, "block");
    if (decision.action === "block") assert.match(decision.questions.join(" "), /runtime stopped.*No code-fix retry/);
    assert.equal((await f.store.list<CheckRun>("CheckRun")).length, 0);
    assert.equal((await f.current()).status?.retries, undefined);
  } finally { f.db.close(); }
});

test("only typed assertions enter code-fix recovery; stale reviewed candidates cannot satisfy verification", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    assert.equal((await f.runStage("verify")).action, "wait");
    await f.finish((await f.store.list<CheckRun>("CheckRun")).at(-1)!, "AssertionFailed");
    const decision = await f.runStage("verify");
    assert.deepEqual(decision, { action: "goto", stage: "implement", retryOf: "verify" });
    f.tree("changed-candidate");
    assert.equal((await f.runStage("verify")).action, "goto");
  } finally { f.db.close(); }
});

test("AC-2: a change-caused failure after the code-fix budget enters a stage-bound recovery episode within one budget", async () => {
  const f = await fixture();
  try {
    const compile = f.compiler.compile.bind(f.compiler);
    f.compiler.compile = (async (...args: Parameters<typeof compile>) => Object.assign(await compile(...args),
      { recovery: { version: "1", maxTotalAttempts: 3, humanNeedReserve: 0, maxOperatorAllowance: 0, diagnosticChecks: [] } })) as typeof compile;    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify", retries: { verify: 2 } } });
    assert.equal((await f.runStage("verify")).action, "wait");
    const run = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
    await f.finish(run, "AssertionFailed");
    const decision = await f.runStage("verify");
    assert.equal(decision.action, "recovery");
    if (decision.action !== "recovery") return;
    assert.equal(decision.unit, "stage:verify");
    assert.equal(decision.trigger.name, run.metadata.name);
    const spent = await f.current();
    await f.store.updateStatus({ ...spent, status: { ...spent.status!, recovery: [1, 2, 3].map((n) => ({ id: `e${n}`, workItemUid: spent.metadata.uid!, planFingerprint: decision.planFingerprint,
      unit: "stage:verify", policyVersion: "1", stage: "verify", maxTotalAttempts: 3, operatorAllowance: 0, trigger: { kind: "CheckRun" as const, name: "x", uid: "x" },
      diagnosticAttempts: 0, codeAttempts: 0, executionAttempts: 0, disposition: "resolved" as const })) } });
    assert.equal((await f.runStage("verify")).action, "block", "the single reserved budget is spent");
  } finally { f.db.close(); }
});

test("missing required evidence needs an explicit revision-bound waiver; waiver never fabricates Passed", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    await f.seedPass("build", "verification", "verify");
    await f.seedPass("test", "verification", "verify");
    const decision = await f.runStage("verify");
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") throw new Error("waiver expected");
    assert.deepEqual(decision.verification?.requirements, ["repo/manual-acceptance"]);
    assert.match((await f.service.check(await f.current()))!, /missing\/stale evidence/);
    const waiver = await f.store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval",
      metadata: { name: "waiver", namespace: "default", ownerReferences: [ownerRef(f.item)] },
      spec: { workItemRef: { name: "item" }, stage: "verify", approvers: [], verification: decision.verification } });
    await assert.rejects(f.service.validate(waiver, "approve", "short"), /explicit reason/);
    await f.service.validate(waiver, "approve", "Reviewed external evidence gap");
    await f.store.update({ ...waiver, spec: { ...waiver.spec, decision: "approve", decidedBy: "human", comment: "Reviewed external evidence gap" } });
    assert.equal(await f.service.check(await f.current()), undefined);
    assert.equal((await f.store.list<CheckRun>("CheckRun")).length, 3, "no fake manual check created");
    await f.store.create<Approval>({ ...waiver, metadata: { name: "fresh-waiver-review", namespace: "default", ownerReferences: [ownerRef(f.item)] },
      spec: { ...waiver.spec, decision: undefined, decidedBy: undefined, comment: undefined } });
    assert.match((await f.service.check(await f.current()))!, /missing\/stale evidence/);
    f.tree("new");
    await assert.rejects(f.service.validate(waiver, "approve", "Reviewed external evidence gap"), /reviewed|changed/);
    assert.ok(await f.service.check(await f.current()));
  } finally { f.db.close(); }
});

test("a durable publication hold keeps a restarted item from publishing", async () => {
  const f = await fixture();
  try {
    const wi = await f.current();
    await f.store.update<WorkItem>({ ...wi, spec: { ...wi.spec, publicationDisabled: true, restart: { id: "hold", stage: "validation-plan", requestedBy: "human" } } });
    const current = await f.current();
    await f.store.updateStatus({ ...current, status: { ...current.status!, stage: "ship", phase: "Running", restartHandled: "hold" } });
    const controller = createWorkItemController({ reader: f.store, writer: f.store, status: f.store, compiler: f.compiler, clock: f.clock,
      events: f.events, gates: new Registry<GateEvaluator>(), outbox: { enqueue: async () => { throw new Error("publication must stay disabled"); } }, workspaces: { supports: () => false } });
    await controller.reconcile(keyOf(current));
    assert.equal((await f.current()).status?.message, "Publication disabled by human policy");
  } finally { f.db.close(); }
});

test("audit publication failure cannot flip a completed agent to Failed or execute it again", async () => {
  const f = await fixture();
  try {
    const seed = (await f.store.get<AgentRun>("AgentRun", "default", "planner"))!;
    const run = await f.store.create<AgentRun>({ ...seed, metadata: { name: "audit-run", namespace: "default", ownerReferences: [ownerRef(f.item)] }, status: undefined });
    const recorder = { ref: { id: "test", namespace: "default" }, record: async () => {} };
    const errors: string[] = [];
    let executions = 0;
    const controller = createAgentRunController({ reader: f.store, writer: f.store, status: f.store, clock: f.clock,
      redactor: { redact: (text) => text }, onError: (message) => errors.push(message),
      events: { normal: async (_object, reason) => { if (reason === "Succeeded") throw new Error("audit persistence unavailable"); }, warning: async () => { throw new Error("must not downgrade"); } },
      recorders: { forRun: async () => recorder, forConversation: async () => recorder },
      contexts: { create: async () => ({ run, workItem: await f.current(), agent: { apiVersion: API_VERSION, kind: "Agent", metadata: { name: "architect" }, spec: { role: "Architect" }, body: "" },
        skills: [], inputs: [], approvals: [], clarifications: [], repositories: [f.repo], workspaces: [], sections: [], transcript: recorder }) },
      executor: { name: "test", canExecute: () => true, execute: async () => { executions++; return { summary: "completed", provenance: { executor: "test" } }; } },
    });
    await controller.reconcile(keyOf(run));
    await controller.stop();
    assert.equal((await f.store.get<AgentRun>("AgentRun", "default", run.metadata.name))?.status?.phase, "Succeeded");
    await controller.reconcile(keyOf(run));
    await controller.stop();
    assert.equal(executions, 1);
    assert.deepEqual(errors, ["audit persistence unavailable"]);
  } finally { f.db.close(); }
});

test("plan review shows required checks without a command as known evidence gaps; unpassable ones are distinct", async () => {
  const f = await fixture();
  try {
    const ctx = await f.context("spec-review");
    const decision = await f.service.gates.find((g) => g.type === ctx.gate.type)!.evaluate(ctx);
    assert.equal(decision.action, "await-approval");
    assert.match(decision.action === "await-approval" ? decision.criteria?.join("\n") ?? "" : "", /Known evidence gaps: repo\/manual-acceptance/);
    assert.deepEqual((await f.service.inspect(ANONYMOUS, "item")).gaps?.map((g) => g.check), ["manual-acceptance"]);
    assert.deepEqual(verificationPolicyGaps({ ...f.repo, spec: { ...f.repo.spec, verification: { ...f.repo.spec.verification!, waivableChecks: [], readinessChecks: ["lint"] } } })
      .map((g) => [g.check, g.role, g.waivable]), [["manual-acceptance", "required", false], ["lint", "readiness", false]]);
    assert.match(gapCriterion([{ repository: "repo", check: "manual-acceptance", role: "required", waivable: false }])[0], /Unpassable checks/);
  } finally { f.db.close(); }
});

test("ADR-0063: entering verify collects the plan's checks before the verifier runs; the gate then only confirms", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    const verify = (await f.context("verify")).stage;
    const checks = async () => (await f.store.list<CheckRun>("CheckRun")).filter((r) => r.spec.workflow?.purpose === "verification");

    await f.service.check(await f.current());
    await f.service.recover(await f.current());
    assert.equal((await checks()).length, 0, "a permission check never submits checks");

    for (const check of ["build", "test"]) {
      assert.equal((await f.service.beforeStage(await f.current(), verify)).action, "wait", `entry waits for ${check}`);
      const submitted = (await checks()).at(-1)!;
      assert.equal(submitted.spec.check, check);
      assert.equal(submitted.spec.requestedBy, "gate");
      assert.equal((await f.service.beforeStage(await f.current(), verify)).action, "wait", "an active check keeps the stage waiting");
      await f.finish(submitted, "Passed");
    }
    assert.equal((await f.service.beforeStage(await f.current(), verify)).action, "advance", "the verifier may start once evidence is complete");
    const before = (await checks()).length;
    const decision = await f.runStage("verify");
    assert.equal(decision.action, "await-approval", "only the unconfigured manual check needs a waiver");
    assert.equal((await checks()).length, before, "the gate reuses the evidence collected at entry");
  } finally { f.db.close(); }
});

test("ADR-0042 §4: entering a later stage with a stale preflight reruns it in place instead of asking for a restart", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    const old = await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    await f.store.update<CheckRun>({ ...old, metadata: { ...old.metadata, labels: { "factory.ai-dlc.io/superseded": "definition-change" } } });
    const verify = (await f.context("verify")).stage;

    assert.equal((await f.service.beforeStage(await f.current(), verify)).action, "wait");
    const refreshed = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
    assert.equal(refreshed.spec.workflow?.purpose, "preflight");
    assert.equal(refreshed.spec.workflow?.stage, "verify", "rerun at the current stage, nothing after preflight is discarded");
    await f.finish(refreshed, "Passed");
    const next = await f.service.beforeStage(await f.current(), verify);
    assert.equal(next.action, "wait");
    assert.equal((await f.store.list<CheckRun>("CheckRun")).at(-1)!.spec.workflow?.purpose, "verification", "then the verification evidence is collected");

  } finally { f.db.close(); }
});

test("ADR-0064: editing publication, code search or agent context keeps the approved plan and check evidence current", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
    const approved = (await f.service.plan(await f.current(), true)).fingerprint;
    const repo = (await f.store.get<Repository>("Repository", "factory-system", "repo"))!;
    const published = await f.store.update<Repository>({ ...repo, metadata: { ...repo.metadata, labels: { team: "x" } },
      spec: { ...repo.spec, git: { url: "https://example.test/repo.git", defaultBranch: "main" }, index: { enabled: true }, context: { docs: ["docs"] } } });

    assert.equal((await f.service.plan(await f.current(), true)).fingerprint, approved, "no plan re-confirmation");
    assert.equal((await f.service.beforeStage(await f.current(), (await f.context("verify")).stage)).action, "wait");
    assert.deepEqual((await f.store.list<CheckRun>("CheckRun")).map((r) => r.spec.workflow?.purpose), ["preflight", "verification"],
      "the earlier preflight still counts; only the verification checks are collected");

    await f.store.update<Repository>({ ...published, spec: { ...published.spec, checks: { ...published.spec.checks, preflight: "prepare --strict" } } });
    assert.notEqual((await f.service.plan(await f.current(), false)).fingerprint, approved, "a changed check definition needs the plan re-confirmed");
  } finally { f.db.close(); }
});

test("ADR-0064: a stale preflight at the publish stage is rerun in place before publication instead of blocking", async () => {
  const f = await fixture();
  try {
    await f.approve("spec-review");
    const old = await f.seedPass("preflight", "preflight", "preflight");
    await f.approve("code-review");
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "ship" } });
    await f.store.update<CheckRun>({ ...old, metadata: { ...old.metadata, labels: { "factory.ai-dlc.io/superseded": "definition-change" } } });

    assert.match((await f.service.check(await f.current()))!, /preflight repo\/preflight is missing or stale/);
    assert.equal((await f.service.recover(await f.current()))?.action, "wait");
    assert.equal((await f.service.recover(await f.current()))?.action, "wait", "an active refresh keeps publication waiting");
    assert.equal((await f.store.list<CheckRun>("CheckRun")).length, 2, "repeated reconciles submit the refresh once");
    const refreshed = (await f.store.list<CheckRun>("CheckRun")).at(-1)!;
    assert.equal(refreshed.spec.workflow?.purpose, "preflight");
    assert.equal(refreshed.spec.workflow?.stage, "ship");
  } finally { f.db.close(); }
});

test("preflight checks are authorized at the preflight stage and later stages only", () => {
  const workflow = { spec: { verification: { planningStage: "plan", reviewStage: "review", preflightStage: "preflight", verifyStage: "verify",
    implementationStage: "implement", maxCodeAttempts: 1, maxExecutionAttempts: 1, retryDelayMs: 1 },
    phases: [{ name: "p", stages: [{ name: "plan" }, { name: "review" }, { name: "preflight" }, { name: "implement" }, { name: "verify" }] }] } } as unknown as Workflow;
  const origin = (stage: string) => ({ stage, round: 1, purpose: "preflight" as const, planFingerprint: "x", attempt: 1 });
  assert.equal(originAuthorized(workflow, origin("preflight")), true);
  assert.equal(originAuthorized(workflow, origin("verify")), true);
  assert.equal(originAuthorized(workflow, origin("review")), false, "never before the plan is approved");
  assert.equal(originAuthorized(workflow, origin("unknown")), false);
});

async function exhaustedScan(f: Awaited<ReturnType<typeof fixture>>) {
  await f.approve("spec-review");
  await f.seedPass("preflight", "preflight", "preflight");
  await f.approve("code-review");
  const wi = await f.current();
  await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
  const ws = await f.store.get<Workspace>("Workspace", "default", "ws");
  await f.store.updateStatus({ ...ws!, status: { ...ws!.status!, baseCommit: "a".repeat(40) } });
  const contract = await f.service.plan(await f.current(), true);
  for (const check of ["build", "test"]) await f.seedPass(check, "verification", "verify");
  return { repo: f.repo, contract };
}

test("AC-1: an exhausted waivable check reaches the waiver path and never asks for a retry", async () => {
  const f = await fixture(false, false);
  try {
    await exhaustedScan(f);
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.service.beforeStage(await f.current(), (await f.context("verify")).stage)).action, "wait");
      await f.finish((await f.store.list<CheckRun>("CheckRun")).at(-1)!, "UnknownFailure");
    }
    const decision = await f.runStage("verify");
    assert.equal(decision.action, "await-approval");
  } finally { f.db.close(); }
});

test("AC-3: pre-existing findings with a comparable baseline get a policy waiver; AC-8 the veto is durable", async () => {
  const f = await fixture(false, true);
  try {
    const { contract } = await exhaustedScan(f);
    const findings = async (run: CheckRun, ids: string[]) => f.store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed", outcome: "FindingsReported",
      finalSnapshot: run.spec.snapshot, finishedAt: "2026-11-13T11:00:00Z", findings: ids.map((id) => ({ id })) } });
    const verify = (await f.context("verify")).stage;
    assert.equal((await f.service.beforeStage(await f.current(), verify)).action, "wait");
    await findings((await f.store.list<CheckRun>("CheckRun")).at(-1)!, ["adv-1"]);
    const baseline = await f.scheduler.submit({ workItem: await f.current(), workspace: f.workspace, repository: f.repo, check: "manual-acceptance", requestedBy: "fixture",
      requestId: "baseline", workflow: { stage: "verify", round: 1, purpose: "baseline", planFingerprint: contract.fingerprint, attempt: 9, baselineCommit: "a".repeat(40) } });
    await f.store.update({ ...baseline, spec: { ...baseline.spec, repositoryVersion: (await f.store.list<CheckRun>("CheckRun")).at(-2)!.spec.repositoryVersion } });
    const stored = (await f.store.list<CheckRun>("CheckRun")).find((r) => r.spec.workflow?.purpose === "baseline")!;
    await findings(stored, ["adv-1", "adv-2"]);
    const decision = await f.runStage("verify");
    assert.equal(decision.action, "await-approval");
    const [approval] = await f.store.list<Approval>("Approval", { namespace: "default" }).then((all) => all.filter((a) => a.spec.verification?.kind === "waiver"));
    assert.match(approval.spec.decidedBy ?? "", /^policy:repo@/);
    assert.equal(approval.spec.decision, "approve");
    await f.service.validate(approval, "approve", approval.spec.comment);
    await f.store.update({ ...approval, spec: { ...approval.spec, decision: "reject", decidedBy: "human" } });
    await f.runStage("verify");
    const after = (await f.store.list<Approval>("Approval", { namespace: "default" })).filter((a) => a.spec.verification?.kind === "waiver");
    assert.equal(after.length, 1);
    assert.equal(after[0].spec.decision, "reject");
  } finally { f.db.close(); }
});

async function flakyAtVerify(f: Awaited<ReturnType<typeof fixture>>, touched = false) {
  const { testId } = await import("./model/tests.ts");
  const fail = (run: CheckRun, failed: string, passed: string, isTouched = false) => f.store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed",
    outcome: "AssertionFailed", finalSnapshot: run.spec.snapshot, logsIncomplete: false, finishedAt: "2026-11-13T11:00:00Z",
    tests: { failed: [{ name: failed, file: "src/a.test.ts", touched: isTouched }], passed: [testId(passed)], skipped: 0 } } });
  await f.approve("spec-review");
  await f.seedPass("preflight", "preflight", "preflight");
  await f.approve("code-review");
  const wi = await f.current();
  await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "verify" } });
  for (const check of ["build", "manual-acceptance"]) await f.seedPass(check, "verification", "verify");
  const testRuns = async () => (await f.store.list<CheckRun>("CheckRun")).filter((r) => r.spec.check === "test" && r.spec.workflow?.purpose === "verification");
  assert.equal((await f.runStage("verify")).action, "wait");
  await fail((await testRuns())[0], "cleanup", "drafting", touched);
  const second = await f.runStage("verify");
  if (touched) return second;
  assert.equal(second.action, "wait", "an untouched failure is confirmed by another attempt, not sent to the developer");
  assert.equal((await testRuns()).length, 2);
  await fail((await testRuns())[1], "drafting", "cleanup");
  return f.runStage("verify");
}

test("ADR-0086: a flaky required check reaches the human waiver even when not waivable; a touched failure goes to the developer", async () => {
  const f = await fixture(false, false);
  try {
    const decision = await flakyAtVerify(f);
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") return;
    assert.deepEqual(decision.verification?.requirements, ["repo/test"], "waived, never Passed");
  } finally { f.db.close(); }
  const t = await fixture(false, false);
  try {
    assert.deepEqual(await flakyAtVerify(t, true), { action: "goto", stage: "implement", retryOf: "verify" });
  } finally { t.db.close(); }
});

test("ADR-0086: autoWaive when: flaky waives a flaky waivable check by policy", async () => {
  const f = await fixture(false, false, true);
  try {
    assert.equal((await flakyAtVerify(f)).action, "await-approval");
    const [approval] = (await f.store.list<Approval>("Approval", { namespace: "default" })).filter((a) => a.spec.verification?.kind === "waiver");
    assert.match(approval.spec.decidedBy ?? "", /^policy:repo@/);
    assert.equal(approval.spec.decision, "approve");
    assert.match(approval.spec.comment ?? "", /Flaky .*repo\/test \(cleanup, drafting\)/);
  } finally { f.db.close(); }
});
