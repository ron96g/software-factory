import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Approval, Artifact, CheckOutcome, CheckRun, Repository, WorkItem, Workflow, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { ANONYMOUS, SandboxUnavailableError, type CheckRunScheduler, type ExecutionContext, type GateContext, type GateDecision } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { VerificationService } from "./verification/service.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { createAgentRunController } from "./runtime/controllers/agentrun.ts";
import { Registry } from "./registry/registry.ts";
import type { GateEvaluator } from "./ports/index.ts";

async function fixture(preparation = false) {
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
    spec: { checks: { preflight: "prepare", build: "build", test: { command: "tests", resultFormat: "go-test-json" } },
      verification: { requiredChecks: ["build", "test", "manual-acceptance"], preflightChecks: ["preflight"],
        ...(preparation ? { preparationChecks: ["build"] } : {}), waivableChecks: ["manual-acceptance"] } } });
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
        repositoryRef: { name: "repo" }, repositoryVersion: repo.metadata.resourceVersion!, check: request.check, command: request.check,
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
    assert.equal((await f.service.beforeStage(await f.current(), stage)).action, "block");
    await f.seedPass("preflight", "preflight", "preflight");
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

test("migration is explicit, deduplicated and preserves a durable publication hold", async () => {
  const f = await fixture();
  try {
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { phase: "Failed", stage: "verify", round: 20 } });
    const migrated = await f.service.migrate(ANONYMOUS, "item", { workflow: "verified", requestId: "migration" });
    assert.equal(migrated.spec.publicationDisabled, true);
    assert.equal(migrated.spec.restart?.stage, "validation-plan");
    const again = await f.service.migrate(ANONYMOUS, "item", { workflow: "verified", requestId: "migration" });
    assert.equal(again.metadata.resourceVersion, migrated.metadata.resourceVersion);
    await assert.rejects(f.service.migrate(ANONYMOUS, "item", { workflow: "other", requestId: "migration" }), /different workflow/);
    const current = await f.current();
    await f.store.updateStatus({ ...current, status: { ...current.status!, stage: "ship", phase: "Running", restartHandled: current.spec.restart!.id } });
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
