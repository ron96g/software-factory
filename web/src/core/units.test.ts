import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Agent, AgentRun, Approval, Artifact, CheckOutcome, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workflow, Workspace } from "./model/kinds.ts";
import { LABEL_SUPERSEDED } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { parseUnitManifest } from "./model/units.ts";
import type { CheckRunScheduler, ExecutionContext, GateEvaluator } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { VerificationService } from "./verification/service.ts";
import { UnitExecutionService } from "./units/service.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { createAgentRunController } from "./runtime/controllers/agentrun.ts";
import { Registry } from "./registry/registry.ts";
import { originAuthorized, validUnitFields } from "./checks/origin.ts";
import { runScrubbed } from "./adapters/sandbox/process.ts";
import { CompletedUnitAttempts } from "./units/history.ts";
import { unitContext } from "./units/context.ts";
import { checkDefinitionVersion } from "./checks/definition-version.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const CRITERIA = [{ id: "AC-1", description: "Loader", checks: ["repo/build", "repo/test"] }, { id: "AC-2", description: "Reload", checks: ["repo/build", "repo/test"] }];
const UNITS = [
  { id: "U0", title: "Loader", dependsOn: [], criteria: ["AC-1"], obligations: [{ id: "U0-O1", description: "Loader with tests", checks: ["repo/build"] }] },
  { id: "U1", title: "Reload", dependsOn: ["U0"], criteria: ["AC-2"], obligations: [{ id: "U1-O1", description: "Reload with tests", checks: ["repo/build", "repo/test"] }] },
];

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-14T12:00:00Z") };
  const store = new SqliteStore(db, clock);
  const policy = { planningStage: "validation-plan", reviewStage: "spec-review", preflightStage: "preflight", verifyStage: "verify",
    implementationStage: "implement", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 0 };
  await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "planned", namespace: "factory-system" },
    spec: { verification: policy, unitExecution: { barrierStage: "code-review", maxCodeAttempts: 1, maxExecutionAttempts: 2 }, phases: [{ name: "construction", stages: [
      { name: "validation-plan" }, { name: "spec-review", gate: { type: "verification-plan-review" } },
      { name: "preflight", gate: { type: "verified-checks" } },
      { name: "implement", steps: [{ name: "write-code", agentRef: { name: "developer" }, outcomes: ["complete", "partial", "blocked"] }], gate: { type: "unit-progress" } },
      { name: "code-review", steps: [{ name: "review", agentRef: { name: "reviewer" } }], gate: { type: "verification-candidate-review" } },
      { name: "verify", gate: { type: "verified-checks" } },
    ] }] } });
  const repo = await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
    spec: { checks: { preflight: "prepare", build: "build", test: "tests" },
      verification: { requiredChecks: ["build", "test"], preflightChecks: ["preflight"], readinessChecks: ["build", "test"] } } });
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
    spec: { title: "Live reload", sourceRef: { name: "manual" }, repositoryRefs: [{ name: "repo" }], workflowRef: { name: "planned" } },
    status: { phase: "Running", stage: "spec-review", round: 1 } });
  const workspace = await store.create<Workspace>({ apiVersion: API_VERSION, kind: "Workspace",
    metadata: { name: "ws", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" }, status: { phase: "Ready", path: "/fake" } });
  const spec = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "spec", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { artifactTypeRef: { name: "spec" }, workItemRef: { name: "item" }, format: "markdown", content: "AC-1, AC-2" } });
  await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata: { name: "planner", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, agentRef: { name: "architect" }, skillRefs: [], stage: "validation-plan", step: "plan", inputs: [{ name: "spec" }], outputs: [{ name: "validation-plan" }] },
    status: { phase: "Succeeded", executor: "tool-loop", provenance: { executor: "tool-loop", definitions: {}, inputs: { spec: spec.metadata.resourceVersion! } } } });
  await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "plan", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { artifactTypeRef: { name: "validation-plan" }, workItemRef: { name: "item" }, producedBy: { agentRunRef: { name: "planner" }, agentRef: { name: "architect" } },
      format: "json", content: JSON.stringify({ criteria: CRITERIA, checks: ["repo/build", "repo/test"], preflight: ["repo/preflight"], units: UNITS }) } });
  let tree = "tree-a";
  const files = new Set<string>();
  const scheduler: CheckRunScheduler = {
    submit: async (request) => store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun",
      metadata: { name: `check-${hash(request.requestId)}`, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: workspace.metadata.uid!,
        repositoryRef: { name: "repo" }, repositoryVersion: checkDefinitionVersion(repo), check: request.check, command: request.check,
        timeoutMs: 1000, snapshot: tree, environment: { runtime: "fake", version: "1", profileVersion: "default" }, requestedBy: request.requestedBy,
        requestFingerprint: request.requestId, workflow: request.workflow } }),
  };
  const compiler = new DefaultWorkflowCompiler(store);
  const events = new StoreEventRecorder(store);
  const redactor = { redact: (text: string) => text };
  const environments = { select: async () => ({ environment: { runtime: "fake", health: async () => ({ runtime: "fake", available: true, isolation: "container" as const }),
    prepare: async () => { throw new Error("never execute"); } }, health: { runtime: "fake", version: "1", available: true, isolation: "container" as const }, candidates: [] }),
  refresh: async () => {} };
  const snapshots = { fingerprint: async () => tree };
  // eslint-disable-next-line prefer-const
  let units: UnitExecutionService;
  const service = new VerificationService({ namespace: "default", reader: store, writer: store, compiler, snapshots, scheduler, events, clock, redactor, environments,
    completeness: { beforeCandidate: (...a) => units.beforeCandidate(...a), assertComplete: (...a) => units.assertComplete(...a) } });
  units = new UnitExecutionService({ namespace: "default", reader: store, compiler, contracts: service, candidates: service, scheduler, events, clock, redactor,
    readers: { forWorkspaces: () => ({ readFile: async (path: string) => { if (!files.has(path)) throw new Error("missing"); return ""; },
      listFiles: async () => [...files], searchCode: async () => [] }) } });
  const gates = new Registry<GateEvaluator>();
  for (const gate of service.gates) gates.register(gate.type, gate);
  gates.register(units.gate.type, units.gate);
  const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates,
    outbox: { enqueue: async () => { throw new Error("no publication"); } }, workspaces: { supports: () => false },
    stagePolicy: service, resumptionPolicy: service, assignments: units, runFailures: units });
  const current = async () => (await store.get<WorkItem>("WorkItem", "default", "item"))!;
  const reconcile = () => controller.reconcile(keyOf(item));
  const runs = async () => store.list<AgentRun>("AgentRun", { namespace: "default" });
  const checks = async () => store.list<CheckRun>("CheckRun", { namespace: "default" });

  async function approvePlan() {
    const wi = await current();
    const compiled = await compiler.compile(wi.spec.workflowRef!, "default");
    const stage = compiled.stage("spec-review")!;
    const decision = await gates.get("verification-plan-review")!.evaluate({ workItem: wi, stage, gate: stage.gate! });
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") return;
    await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval", metadata: { name: "plan-approval", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, stage: "spec-review", approvers: [], verification: decision.verification, decision: "approve", decidedBy: "human" } });
    const contract = await service.plan(await current(), true);
    const preflight = await scheduler.submit({ workItem: await current(), workspace, repository: repo, check: "preflight", requestedBy: "fixture", requestId: "preflight",
      workflow: { stage: "preflight", round: 1, purpose: "preflight", planFingerprint: contract.fingerprint, attempt: 1 } });
    await finish(preflight, "Passed");
    const fresh = await current();
    await store.updateStatus({ ...fresh, status: { ...fresh.status!, stage: "implement", step: 0, round: 2 } });
  }
  async function finish(run: CheckRun, outcome: CheckOutcome) {
    return store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed", outcome, finalSnapshot: run.spec.snapshot, logsIncomplete: false, finishedAt: "2026-11-14T11:00:00Z" } });
  }
  async function finishPendingChecks(outcome: CheckOutcome = "Passed") {
    for (const run of await checks()) if (!run.status) await finish(run, outcome);
  }
  /** What a real developer attempt records: a real executor, an outcome and a unit-result with file evidence. */
  async function develop(outcome: "complete" | "partial", unit: string, paths: string[], executor = "tool-loop") {
    const run = (await runs()).find((r) => r.spec.stage === "implement" && !r.status)!;
    assert.deepEqual(run.spec.assignment && "unit" in run.spec.assignment ? run.spec.assignment.unit : run.spec.assignment?.kind, unit);
    for (const path of paths) files.add(path);
    await store.updateStatus<AgentRun>({ ...run, status: { phase: "Succeeded", executor, provenance: { executor, definitions: {}, inputs: {} },
      result: { outcome, summary: `${unit} ${outcome}` } } });
    const manifest = UNITS.find((u) => u.id === unit);
    await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: `${run.metadata.name}-unit-result`, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { artifactTypeRef: { name: "unit-result" }, workItemRef: { name: "item" }, producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: { name: "developer" } },
        format: "json", content: JSON.stringify({ unit, outcome, obligations: manifest?.obligations.map((o) => ({ id: o.id, status: outcome === "complete" ? "done" : "partial",
          evidence: paths.map((path) => ({ path })) })) ?? [] }) } });
    return run;
  }
  /** Runs serial readiness checks to completion: one active check per item at a time. */
  async function settle(until: (wi: WorkItem) => boolean) {
    for (let i = 0; i < 8 && !until(await current()); i++) {
      await finishPendingChecks();
      await reconcile();
    }
  }
  return { db, store, service, units, item, workspace, repo, current, reconcile, runs, checks, approvePlan, finish, finishPendingChecks, develop, settle, events, clock,
    tree: (value: string) => { tree = value; } };
}

test("Unit manifest validation rejects unmapped criteria, cycles, unknown references and checks outside the readiness allowlist", () => {
  const repos = [{ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo" },
    spec: { checks: { build: "b", lint: "l" }, verification: { requiredChecks: ["build"], preflightChecks: [], readinessChecks: ["build"] } } } as Repository];
  const plan = { criteria: [{ id: "AC-1" }, { id: "AC-2" }], checks: ["repo/build", "repo/lint"] };
  const unit = (id: string, extra: object = {}) => ({ id, title: id, dependsOn: [], criteria: ["AC-1"], obligations: [{ id: `${id}-O`, description: "d", checks: ["repo/build"] }], ...extra });
  const error = (raw: unknown) => { const r = parseUnitManifest(raw, plan, repos); return "error" in r ? r.error : ""; };
  assert.match(error([unit("U1")]), /without a delivering Unit: AC-2/);
  assert.match(error([unit("U1", { dependsOn: ["U2"], criteria: ["AC-1", "AC-2"] }), unit("U2", { dependsOn: ["U1"] })]), /cycle/);
  assert.match(error([unit("U1", { criteria: ["AC-9"] })]), /unknown criterion AC-9/);
  assert.match(error([unit("U1", { criteria: ["AC-1", "AC-2"], obligations: [{ id: "O", description: "d", checks: ["repo/lint"] }] })]), /not a configured readiness check/);
  assert.match(error([unit("U1", { criteria: ["AC-1", "AC-2"], obligations: [] })]), /at least one completion obligation/);
  assert.match(error([]), /no units\[\] manifest/);
  assert.ok("units" in parseUnitManifest([unit("U1", { criteria: ["AC-1", "AC-2"] })], plan, repos));
  assert.ok("units" in parseUnitManifest([unit("U0", { criteria: [] }), unit("U1", { criteria: ["AC-1", "AC-2"] })], plan, repos),
    "an infrastructure Unit may deliver no criterion directly");
});

test("mandatory policy checks need no criterion mapping; optional checks and unknown references still do", async () => {
  const f = await fixture();
  try {
    const repo = (await f.store.get<Repository>("Repository", "factory-system", "repo"))!;
    await f.store.update<Repository>({ ...repo, spec: { ...repo.spec, checks: { ...repo.spec.checks, lint: "lint" } } });
    const write = async (content: object) => {
      const artifact = (await f.store.get<Artifact>("Artifact", "default", "plan"))!;
      await f.store.update<Artifact>({ ...artifact, spec: { ...artifact.spec, content: JSON.stringify(content) } });
    };
    const base = { preflight: ["repo/preflight"], units: UNITS.map((u) => ({ ...u, obligations: u.obligations.map((o) => ({ ...o, checks: ["repo/test"] })) })) };
    const criteria = CRITERIA.map((c) => ({ ...c, checks: ["repo/test"] }));
    await write({ ...base, criteria, checks: ["repo/build", "repo/test"] });
    assert.ok((await f.service.plan(await f.current(), false)).plan.checks.includes("repo/build"), "mandatory build needs no criterion");
    await write({ ...base, criteria, checks: ["repo/build", "repo/test", "repo/lint"] });
    await assert.rejects(f.service.plan(await f.current(), false), /optional checks no criterion maps: repo\/lint/);
  } finally { f.db.close(); }
});

test("an attention stop at a gate resumes to human review once its cause is fixed, without approving", async () => {
  const f = await fixture();
  try {
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, phase: "Blocked", blockedBy: undefined, step: 0, message: "malformed plan" } });
    await f.reconcile();
    const resumed = await f.current();
    assert.equal(resumed.status?.phase, "AwaitingApproval");
    const approval = await f.store.get<Approval>("Approval", "default", resumed.status!.blockedBy!.name);
    assert.equal(approval?.spec.decision, undefined, "only a pending human approval is created");
  } finally { f.db.close(); }
});

test("unit readiness origins are bound to a Unit and authorized only at implementation or the barrier stage", () => {
  const workflow = { spec: { verification: { implementationStage: "implement", verifyStage: "verify" }, unitExecution: { barrierStage: "code-review" } } } as Workflow;
  const origin = (extra: Partial<CheckWorkflowOrigin>): CheckWorkflowOrigin => ({ stage: "implement", round: 1, purpose: "unit-readiness", planFingerprint: "p", attempt: 1, ...extra });
  assert.ok(validUnitFields(origin({ unit: "U1", unitRun: "run" })) && originAuthorized(workflow, origin({ unit: "U1", unitRun: "run" })));
  assert.ok(validUnitFields(origin({ stage: "code-review", unit: "*" })) && originAuthorized(workflow, origin({ stage: "code-review", unit: "*" })));
  assert.equal(validUnitFields(origin({ unit: "U1" })), false, "a Unit job names its implementation attempt");
  assert.equal(validUnitFields(origin({ purpose: "verification", unit: "U1", unitRun: "run" })), false);
  assert.equal(originAuthorized(workflow, origin({ stage: "verify", unit: "U1", unitRun: "run" })), false);
  assert.equal(originAuthorized({ spec: { verification: workflow.spec.verification } } as Workflow, origin({ unit: "U1", unitRun: "run" })), false);
});

test("AC-39-2: retry context retains its completed predecessor, not the new running attempt", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    const first = await f.develop("partial", "U0", ["src/loader.ts"]);
    await f.reconcile();
    await f.reconcile();
    await f.reconcile();
    const current = (await f.runs()).find((run) => run.spec.stage === "implement" && !run.status)!;
    assert.ok(current && current.spec.assignment);
    const reader = new CompletedUnitAttempts(f.store);
    const predecessors = await reader.completed(await f.current(), current.spec.assignment!, current.metadata.name);
    assert.deepEqual(predecessors.map((attempt) => attempt.run), [first.metadata.name]);
    assert.equal(predecessors[0].outcome, "partial");
    assert.match(predecessors[0].result!.content, /"status":"partial"/);
    const provider = unitContext({ ledger: f.units, compiler: new DefaultWorkflowCompiler(f.store), redactor: { redact: (s) => s }, attempts: reader });
    const agent: Agent = { apiVersion: API_VERSION, kind: "Agent", metadata: { name: "developer", namespace: "factory-system" }, spec: { role: "developer" }, body: "" };
    const context: ExecutionContext = {
      run: current, workItem: await f.current(),
      agent,
      skills: [], inputs: [], clarifications: [], approvals: [], repositories: [], workspaces: [], sections: [],
      transcript: { ref: { id: current.metadata.name, namespace: "default" }, record: async () => { throw new Error("context provider must not execute agents"); } },
    };
    const [section] = await provider.provide(context);
    const body = JSON.parse(section.content);
    assert.equal(body.previousAttempt.run, first.metadata.name);
    assert.equal(body.currentAttempt.run, current.metadata.name);
    assert.equal(body.attemptHistory.length, 1);
    const [diagnosis] = await provider.provide({ ...context, run: { ...current, spec: {
      ...current.spec, recovery: { episode: "episode", attempt: 1, mode: "diagnosis", planFingerprint: current.spec.assignment!.planFingerprint,
        unit: "U0", policyVersion: "1", trigger: { kind: "AgentRun", name: first.metadata.name, uid: first.metadata.uid! } },
    } } });
    assert.match(diagnosis.content, /Do not implement/);
    assert.doesNotMatch(diagnosis.content, /Implement Unit|Finish with outcome/);
    const replay = await f.store.create<AgentRun>({ ...first, metadata: { name: "replay-r99", namespace: "default",
      ownerReferences: [ownerRef(await f.current())], labels: { "factory.ai-dlc.io/replay": "true" } }, spec: { ...first.spec, replayOf: { name: first.metadata.name } } });
    assert.ok(!((await reader.completed(await f.current(), current.spec.assignment!, current.metadata.name)).some((attempt) => attempt.run === replay.metadata.name)));
    for (const [name, labels, owner] of [
      ["superseded-r98", { [LABEL_SUPERSEDED]: "true" }, ownerRef(await f.current())],
      ["foreign-r97", {}, { ...ownerRef(await f.current()), uid: "recreated-owner" }],
    ] as const) {
      await f.store.create<AgentRun>({ ...first, metadata: { name, namespace: "default", labels, ownerReferences: [owner] } });
    }
    assert.deepEqual((await reader.completed(await f.current(), current.spec.assignment!, current.metadata.name)).map((attempt) => attempt.run), [first.metadata.name]);
  } finally { f.db.close(); }
});

test("units are implemented one at a time and review cannot start while an approved Unit is missing", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    await f.develop("complete", "U0", ["src/loader.ts"]);
    await f.reconcile(); // step done
    await f.reconcile(); // gate: schedules U0 readiness
    assert.equal((await f.checks()).filter((c) => c.spec.workflow?.purpose === "unit-readiness").length, 1);
    await f.finishPendingChecks();
    await f.reconcile(); // U0 ready → next Unit
    assert.equal((await f.current()).status?.stage, "implement");

    // A direct restart into review with U1 missing is routed back to implementation, never to a reviewer.
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "code-review", step: 0 } });
    await f.reconcile();
    assert.equal((await f.current()).status?.stage, "implement");
    assert.equal((await f.current()).status?.retries?.["unit-barrier"], 1);
    assert.ok(!(await f.runs()).some((r) => r.spec.stage === "code-review"), "no reviewer sees an incomplete candidate");
    // The candidate approval guard enforces the same barrier: an override cannot approve missing Units.
    const contract = await f.service.plan(await f.current(), true);
    const candidate = await f.service.candidate(await f.current(), contract);
    const approval = await f.store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval", metadata: { name: "candidate", namespace: "default", ownerReferences: [ownerRef(f.item)] },
      spec: { workItemRef: { name: "item" }, stage: "code-review", approvers: [], verification: { kind: "candidate", fingerprint: candidate.fingerprint, planFingerprint: contract.fingerprint } } });
    await assert.rejects(f.service.validate(approval, "approve", "Override requested by a human"), /Unit U1 not ready/);

    // U1: a partial slice goes back to the developer instead of review.
    await f.reconcile();
    await f.develop("partial", "U1", ["src/reload.ts"]);
    await f.reconcile();
    await f.reconcile();
    assert.equal((await f.current()).status?.stage, "implement");
    assert.equal((await f.current()).status?.retries?.["unit:U1"], 1);
    assert.ok(!(await f.runs()).some((r) => r.spec.stage === "code-review"));

    await f.reconcile();
    await f.develop("complete", "U1", ["src/reload.ts"]);
    await f.reconcile();
    await f.reconcile();
    await f.settle((wi) => wi.status?.stage === "code-review"); // U1 ready, all ready → code-review
    assert.equal((await f.current()).status?.stage, "code-review");

    // Changed candidate (e.g. after the last Unit, preparation) → readiness reruns on the final tree before review.
    f.tree("tree-b");
    await f.reconcile();
    assert.ok(!(await f.runs()).some((r) => r.spec.stage === "code-review"), "stale readiness evidence keeps review closed");
    const barrier = (await f.checks()).filter((c) => c.spec.workflow?.unit === "*");
    assert.equal(barrier.length, 1);
    await f.settle(() => false);
    assert.ok((await f.runs()).some((r) => r.spec.stage === "code-review"), "review starts once every Unit has current evidence");
    const view = await f.units.view(await f.current());
    assert.deepEqual(view.units.map((u) => u.state), ["ready", "ready"]);
    assert.equal(view.barrier?.satisfied, true);
  } finally { f.db.close(); }
});

test("simulated output, missing evidence files and failed readiness checks never make a Unit ready", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    await f.develop("complete", "U0", [], "simulated");
    await f.reconcile();
    await f.reconcile();
    assert.equal((await f.current()).status?.retries?.["unit:U0"], 1, "simulated output is a failed attempt");
    await f.reconcile();
    const run = (await f.runs()).find((r) => r.spec.stage === "implement" && !r.status)!;
    await f.store.updateStatus<AgentRun>({ ...run, status: { phase: "Succeeded", executor: "tool-loop", provenance: { executor: "tool-loop", definitions: {}, inputs: {} }, result: { outcome: "complete" } } });
    await f.store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: `${run.metadata.name}-unit-result`, namespace: "default", ownerReferences: [ownerRef(f.item)] },
      spec: { artifactTypeRef: { name: "unit-result" }, workItemRef: { name: "item" }, producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: { name: "developer" } },
        format: "json", content: JSON.stringify({ unit: "U0", outcome: "complete", obligations: [{ id: "U0-O1", status: "done", evidence: [{ path: "src/invented.ts" }] }] }) } });
    await f.reconcile();
    await f.reconcile();
    const blocked = await f.current();
    assert.equal(blocked.status?.phase, "Blocked", "code-fix budget exhausted → durable human attention, not review");
    const clarification = await f.store.get<{ spec: { questions: string[] } } & Parameters<typeof f.store.create>[0]>("Clarification", "default", blocked.status!.blockedBy!.name);
    assert.match(clarification!.spec.questions[0], /src\/invented\.ts does not exist/);
    assert.deepEqual((clarification!.spec as { askedBy?: unknown }).askedBy, { gate: "unit-progress" }, "a factory stop is not attributed to an agent");
    assert.equal((await f.units.view(blocked)).units[0].state, "blocked");
  } finally { f.db.close(); }
});

test("an unfinished cross-Unit repair goes on to code review instead of asking the human to retry", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    for (const [unit, path] of [["U0", "src/loader.ts"], ["U1", "src/reload.ts"]]) {
      await f.reconcile();
      await f.develop("complete", unit, [path]);
      await f.reconcile();
      await f.reconcile();
      await f.settle((wi) => wi.status?.stage === "code-review" || (wi.status?.stage === "implement" && wi.status.step === 0));
    }
    // The review loop sends the item back to implementation.
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, stage: "implement", step: 0, round: wi.status!.round! + 1 } });
    await f.reconcile();
    await f.develop("partial", "repair", []);
    await f.reconcile();
    await f.reconcile();
    const item = await f.current();
    assert.equal(item.status?.stage, "code-review");
    assert.notEqual(item.status?.phase, "Blocked");
    assert.equal((await f.store.list("Clarification", { namespace: "default" })).length, 0);
    const events = await f.store.list<{ spec: { reason: string } } & Parameters<typeof f.store.create>[0]>("Event", { namespace: "default" });
    assert.ok(events.some((e) => e.spec.reason === "RepairIncomplete"));
  } finally { f.db.close(); }
});

test("an assigned attempt interrupted by a restart is not re-executed and gets a bounded new attempt", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    const run = (await f.runs()).find((r) => r.spec.stage === "implement")!;
    await f.store.updateStatus<AgentRun>({ ...run, status: { phase: "Running", startedAt: "2026-11-14T11:00:00Z" } });
    const fail = async () => { throw new Error("must not execute an interrupted attempt"); };
    const agentRuns = createAgentRunController({ reader: f.store, writer: f.store, status: f.store, events: f.events, clock: f.clock,
      contexts: { create: fail }, executor: { name: "never", canExecute: () => true, execute: fail },
      recorders: { forRun: fail, forConversation: fail }, redactor: { redact: (t) => t }, onError: (m) => { throw new Error(m); } });
    await agentRuns.reconcile(keyOf(run));
    const interrupted = (await f.store.get<AgentRun>("AgentRun", "default", run.metadata.name))!;
    assert.equal(interrupted.status?.phase, "Failed");
    assert.equal(interrupted.status?.interrupted, true);
    await f.reconcile();
    const item = await f.current();
    assert.equal(item.status?.phase, "Running", "the item is not failed");
    assert.equal(item.status?.stage, "implement");
    assert.equal(item.status?.retries?.["unit-exec:U0"], 1);
  } finally { f.db.close(); }
});

test("AC-6: an assigned attempt that exhausted its step budget retries; unassigned runs are unchanged", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    const run = (await f.runs()).find((r) => r.spec.stage === "implement")!;
    await f.store.updateStatus<AgentRun>({ ...run, status: { phase: "Failed", message: "tool loop did not finish within 30 steps" } });
    await f.reconcile();
    const item = await f.current();
    assert.equal(item.status?.phase, "Running", "the item is not failed");
    assert.equal(item.status?.retries?.["unit-exec:U0"], 1);
  } finally { f.db.close(); }
});

test("restarting the barrier stage at an unchanged snapshot schedules fresh barrier jobs instead of waiting forever", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    for (const [unit, path] of [["U0", "src/loader.ts"], ["U1", "src/reload.ts"]]) {
      await f.reconcile();
      await f.develop("complete", unit, [path]);
      await f.reconcile();
      await f.reconcile();
      await f.settle((wi) => wi.status?.stage === "code-review" || (wi.status?.stage === "implement" && wi.status.step === 0));
    }
    assert.equal((await f.current()).status?.stage, "code-review");
    f.tree("prepared");
    await f.reconcile();
    const first = (await f.checks()).filter((c) => c.spec.workflow?.unit === "*" && !c.status);
    assert.equal(first.length, 1);
    // A restart supersedes the pending barrier job; the same snapshot must still get a new, distinct job.
    // (The CheckRun controller then completes the stale-origin job as NotVerified.)
    for (const check of first) {
      const labelled = await f.store.update<CheckRun>({ ...check, metadata: { ...check.metadata, labels: { "factory.ai-dlc.io/superseded": "restart" } } });
      await f.finish(labelled, "NotVerified");
    }
    const wi = await f.current();
    await f.store.updateStatus({ ...wi, status: { ...wi.status!, round: wi.status!.round! + 1, step: 0 } });
    await f.reconcile();
    const fresh = (await f.checks()).filter((c) => c.spec.workflow?.unit === "*" && !c.status && !c.metadata.labels?.["factory.ai-dlc.io/superseded"]);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].metadata.name, first[0].metadata.name);
  } finally { f.db.close(); }
});

test("an interrupted attempt whose approved plan became invalid blocks visibly instead of failing reconciliation", async () => {
  const f = await fixture();
  try {
    await f.approvePlan();
    await f.reconcile();
    const run = (await f.runs()).find((r) => r.spec.stage === "implement")!;
    await f.store.updateStatus<AgentRun>({ ...run, status: { phase: "Failed", interrupted: true, message: "interrupted" } });
    const repo = (await f.store.get<Repository>("Repository", "factory-system", "repo"))!;
    await f.store.update<Repository>({ ...repo, spec: { ...repo.spec, checks: { ...repo.spec.checks, lint: "lint" } } });
    await f.reconcile();
    const item = await f.current();
    assert.equal(item.status?.phase, "Blocked");
    assert.ok(item.status?.blockedBy?.kind === "Clarification");
  } finally { f.db.close(); }
});

test("check output capture keeps complete logs beyond 64 KiB up to the configured limit", async () => {
  const command = "head -c 100000 /dev/zero | tr '\\0' a";
  const full = await runScrubbed(command, process.cwd(), 10_000, {}, 1024 * 1024);
  assert.equal(full.stdout.length, 100_000);
  assert.equal(full.truncated, false);
  const capped = await runScrubbed(command, process.cwd(), 10_000);
  assert.equal(capped.truncated, true, "the default agent-tool cap stays visibly truncated");
});

test("ADR-0079: a Unit whose readiness failures are flaky is ready without a code fix; a failure the change touched is fixed", async () => {
  const { testId } = await import("./model/tests.ts");
  const fail = (f: Awaited<ReturnType<typeof fixture>>, run: CheckRun, failed: string, passed: string, touched = false) =>
    f.store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed", outcome: "AssertionFailed", finalSnapshot: run.spec.snapshot, logsIncomplete: false,
      finishedAt: "2026-11-14T11:00:00Z", tests: { failed: [{ name: failed, file: "src/a.test.ts", touched }], passed: [testId(passed)], skipped: 0 } } });
  const pending = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.checks()).filter((c) => !c.status && c.spec.workflow?.purpose === "unit-readiness");

  const flaky = await fixture();
  try {
    await flaky.approvePlan();
    await flaky.reconcile();
    await flaky.develop("complete", "U0", ["src/loader.ts"]);
    await flaky.reconcile();
    await flaky.reconcile();
    const [first] = await pending(flaky);
    await fail(flaky, first, "cleanup", "drafting");
    await flaky.reconcile();
    assert.equal((await flaky.current()).status?.retries?.["unit:U0"], undefined, "no code fix for an untouched failure yet");
    const [second] = await pending(flaky);
    assert.ok(second, "the failure is confirmed by another attempt");
    await fail(flaky, second, "drafting", "cleanup");
    await flaky.reconcile();
    const view = await flaky.units.view(await flaky.current());
    assert.equal(view.units[0].state, "ready");
    assert.equal(view.units[0].checks[0].outcome, "Flaky");
    assert.equal((await flaky.current()).status?.retries?.["unit:U0"], undefined);
  } finally { flaky.db.close(); }

  const touched = await fixture();
  try {
    await touched.approvePlan();
    await touched.reconcile();
    await touched.develop("complete", "U0", ["src/loader.ts"]);
    await touched.reconcile();
    await touched.reconcile();
    const [first] = await pending(touched);
    await fail(touched, first, "loader works", "other", true);
    await touched.reconcile();
    assert.equal((await touched.current()).status?.retries?.["unit:U0"], 1, "a failure in a test the change touched goes to the developer");
  } finally { touched.db.close(); }
});

test("ADR-0079: a flaky check at the pre-review barrier lets review start instead of waiting forever", async () => {
  const { testId } = await import("./model/tests.ts");
  const f = await fixture();
  try {
    await f.approvePlan();
    for (const [unit, path] of [["U0", "src/loader.ts"], ["U1", "src/reload.ts"]]) {
      await f.reconcile();
      await f.develop("complete", unit, [path]);
      await f.reconcile();
      await f.reconcile();
      await f.settle((wi) => wi.status?.stage === "code-review" || (wi.status?.stage === "implement" && wi.status.step === 0));
    }
    assert.equal((await f.current()).status?.stage, "code-review");
    f.tree("tree-b"); // the final candidate differs: the barrier re-establishes readiness
    const barrier = async () => (await f.checks()).filter((c) => c.spec.workflow?.unit === "*" && !c.status);
    const fail = (run: CheckRun, failed: string, passed: string) => f.store.updateStatus<CheckRun>({ ...run, status: { phase: "Completed", outcome: "AssertionFailed",
      finalSnapshot: run.spec.snapshot, logsIncomplete: false, finishedAt: "2026-11-14T11:00:00Z",
      tests: { failed: [{ name: failed, file: "src/a.test.ts", touched: false }], passed: [testId(passed)], skipped: 0 } } });
    for (let i = 0; i < 12 && !(await f.runs()).some((r) => r.spec.stage === "code-review"); i++) {
      await f.reconcile();
      for (const run of await barrier()) {
        if (run.spec.check !== "test") await f.finish(run, "Passed");
        else await fail(run, run.spec.workflow!.attempt === 1 ? "cleanup" : "drafting", run.spec.workflow!.attempt === 1 ? "drafting" : "cleanup");
      }
    }
    assert.ok((await f.runs()).some((r) => r.spec.stage === "code-review"), "review starts on flaky barrier evidence");
    assert.equal((await f.units.view(await f.current())).barrier?.satisfied, true);
  } finally { f.db.close(); }
});
