import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workflow, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { StoreError, type CheckExecutionRunner, type ExecResult, type ExecutionEnvironment, type ExecutionEnvironmentSelector } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { Registry } from "./registry/registry.ts";
import { WorkflowCheckScheduler } from "./checks/scheduler.ts";
import { createCheckRunController } from "./checks/controller.ts";
import { checkRunValidator } from "./checks/admission.ts";
import { exitCodeClassifier, goTestJsonClassifier, registerCheckResultClassifiers } from "./checks/classifiers.ts";
import type { CheckResultClassifier, VerificationContracts } from "./ports/verification.ts";

const health = { runtime: "test-runtime", available: true, isolation: "container" as const, version: "v1" };
const environment: ExecutionEnvironment = {
  runtime: health.runtime,
  health: async () => health,
  prepare: async () => { throw new Error("test runner must not prepare a real environment"); },
};
const environments: ExecutionEnvironmentSelector = {
  select: async () => ({ environment, health, candidates: [health] }),
  refresh: async () => {},
};

async function fixture(options: { stage?: string; purpose?: CheckWorkflowOrigin["purpose"]; format?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-13T10:00:00.000Z") };
  const store = new SqliteStore(db, clock);
  const logs = new SqliteTranscriptStore(db, clock);
  const stage = options.stage ?? (options.purpose === "preflight" ? "preflight" : options.purpose === "preparation" ? "code-review" : "verify");
  const purpose = options.purpose ?? (stage === "preflight" ? "preflight" : "verification");
  const workflow = await store.create<Workflow>({
    apiVersion: API_VERSION,
    kind: "Workflow",
    metadata: { name: "workflow", namespace: "default" },
    spec: {
      verification: {
        planningStage: "plan", reviewStage: "review", preflightStage: "preflight", verifyStage: "verify",
        implementationStage: "implement", preparationStage: "code-review", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 100,
      },
      phases: [],
    },
  });
  const repository = await store.create<Repository>({
    apiVersion: API_VERSION,
    kind: "Repository",
    metadata: { name: "repo", namespace: "default" },
    spec: {
      checks: {
        test: { command: "trusted-test-command", timeoutMs: 42, resultFormat: options.format ?? "go-test-json" },
        setup: { command: "trusted-setup-command", timeoutMs: 84, resultFormat: "exit-code" },
        unknown: { command: "trusted-unknown-command", timeoutMs: 21, resultFormat: "future-format" },
        focused: { command: "trusted-focused-command", timeoutMs: 42, resultFormat: "exit-code" },
      },
      verification: { requiredChecks: ["test", "unknown"], preflightChecks: ["setup"], preparationChecks: ["setup"] },
    },
  });
  const item = await store.create<WorkItem>({
    apiVersion: API_VERSION,
    kind: "WorkItem",
    metadata: { name: "item", namespace: "default" },
    spec: { title: "Runtime check", sourceRef: { name: "manual" }, workflowRef: { name: workflow.metadata.name } },
    status: { phase: "Running", stage, round: 3 },
  });
  const workspace = await store.create<Workspace>({
    apiVersion: API_VERSION,
    kind: "Workspace",
    metadata: { name: "workspace", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: item.metadata.name }, repositoryRef: { name: repository.metadata.name }, branch: "factory/item" },
    status: { phase: "Ready", path: "/fake-workspace" },
  });
  const callerName = `${item.metadata.name}-${stage}-0-r3`;
  const caller = await store.create<AgentRun>({
    apiVersion: API_VERSION,
    kind: "AgentRun",
    metadata: {
      name: callerName,
      namespace: "default",
      ownerReferences: [ownerRef(item)],
      labels: { "factory.ai-dlc.io/workitem": item.metadata.name, "factory.ai-dlc.io/stage": stage },
    },
    spec: { workItemRef: { name: item.metadata.name }, agentRef: { name: "test-agent" }, skillRefs: [],
      stage, step: "test", inputs: [], outputs: [] },
    status: { phase: purpose === "preparation" ? "Succeeded" : "Running" },
  });
  let fingerprint = "candidate-a";
  const snapshots = { fingerprint: async () => fingerprint };
  const redactor = { redact: (text: string) => text.replaceAll("SECRET", "[redacted]") };
  const scheduler = new WorkflowCheckScheduler({ reader: store, writer: store, snapshots, environments, redactor });
  const origin: CheckWorkflowOrigin = {
    stage, round: 3, purpose, planFingerprint: "plan-fingerprint", attempt: 1,
    ...(purpose === "preparation" ? {} : { agentRunRef: { name: caller.metadata.name },
      agentRequestId: "agent-request-1", agentRunUid: caller.metadata.uid! }),
  };
  const submit = (check = purpose === "preflight" || purpose === "preparation" ? "setup" : "test", requestId = "request", workflowOrigin = origin) =>
    scheduler.submit({ workItem: item, workspace, repository, check, requestId, requestedBy: "agent-run", workflow: workflowOrigin });
  let result: ExecResult = { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 9, termination: { kind: "exit" } };
  let calls = 0;
  const runner: CheckExecutionRunner = {
    execute: async () => { calls++; return result; },
  };
  const errors: string[] = [];
  const classifiers = new Registry<CheckResultClassifier>();
  registerCheckResultClassifiers(classifiers);
  const controller = (execution: CheckExecutionRunner = runner, contracts?: VerificationContracts) => createCheckRunController({
    reader: store, status: store, logs, runner: execution, snapshots, clock,
    events: new StoreEventRecorder(store), redactor, onError: (message) => errors.push(message), classifiers, contracts,
  });
  return {
    db, store, logs, scheduler, submit, item, workspace, repository, caller, origin,
    snapshot: (value: string) => { fingerprint = value; },
    result: (value: ExecResult) => { result = value; },
    controller, calls: () => calls, errors,
  };
}

test("preparation admission and execution retain successful command classification without passing a changed tree", async () => {
  const f = await fixture({ purpose: "preparation" });
  const c = f.controller({ execute: async () => {
    f.snapshot("generated");
    return { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1, termination: { kind: "exit" } };
  } });
  try {
    const run = await f.submit();
    assert.deepEqual(await checkRunValidator().validate(run, { operation: "CREATE", reader: f.store }), []);
    await c.reconcile(keyOf(run));
    await c.stop();
    const done = (await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name))!;
    assert.equal(done.status?.executionOutcome, "Passed");
    assert.equal(done.status?.outcome, "NotVerified");
    assert.equal(done.status?.finalSnapshot, "generated");
  } finally { await c.stop(); f.db.close(); }
});

test("additional configured checks can run but stale or unapproved plan evidence cannot execute", async () => {
  const f = await fixture();
  try {
    const job = await f.submit("focused");
    const c = f.controller(undefined, { plan: async () => { throw new StoreError("fresh plan approval required", "Invalid"); } });
    await c.reconcile(keyOf(job));
    await c.stop();
    assert.equal(f.calls(), 0);
    const done = (await f.store.get<CheckRun>("CheckRun", "default", job.metadata.name))!;
    assert.equal(done.status?.outcome, "NotVerified");
    assert.match(done.status?.message ?? "", /fresh plan approval/);
  } finally { f.db.close(); }
});

test("workflow scheduling pins named config and is idempotent across snapshot drift", async () => {
  const f = await fixture();
  try {
    const pending = await f.submit();
    assert.equal(pending.status, undefined);
    assert.equal(pending.spec.command, "trusted-test-command");
    assert.equal(pending.spec.timeoutMs, 42);
    assert.equal(pending.spec.resultFormat, "go-test-json");
    assert.equal(pending.spec.snapshot, "candidate-a");
    assert.deepEqual(pending.spec.workflow, f.origin);

    f.snapshot("candidate-b");
    const retry = await f.submit();
    assert.equal(retry.metadata.uid, pending.metadata.uid);
    assert.equal(retry.spec.snapshot, "candidate-a");
    await assert.rejects(f.submit("unknown"), StoreError);
  } finally { f.db.close(); }
});

test("scheduler rejects stale origins, foreign/replay/superseded callers, active overlap and malformed origins", async () => {
  const stale = await fixture();
  try {
    await assert.rejects(stale.submit("test", "stale", { ...stale.origin, round: 2 }), /current active stage and round/);
  } finally { stale.db.close(); }

  const foreign = await fixture();
  try {
    await assert.rejects(foreign.submit("test", "foreign", { ...foreign.origin, agentRunRef: { name: "other-caller" } }), /active, current-round AgentRun/);
    await foreign.store.update({ ...foreign.caller, spec: { ...foreign.caller.spec, replayOf: { name: "older-run" } } });
    await assert.rejects(foreign.submit("test", "replay"), /active, current-round AgentRun/);
  } finally { foreign.db.close(); }

  const superseded = await fixture();
  try {
    await superseded.store.update({
      ...superseded.caller,
      metadata: { ...superseded.caller.metadata, labels: { ...superseded.caller.metadata.labels, "factory.ai-dlc.io/superseded": "restart" } },
    });
    await assert.rejects(superseded.submit("test", "superseded"), /active, current-round AgentRun/);
  } finally { superseded.db.close(); }

  const recreated = await fixture();
  try {
    const originalUid = recreated.caller.metadata.uid!;
    await recreated.store.delete("AgentRun", "default", recreated.caller.metadata.name);
    await recreated.store.create<AgentRun>({
      ...recreated.caller,
      metadata: {
        ...recreated.caller.metadata,
        uid: undefined,
        resourceVersion: undefined,
        creationTimestamp: undefined,
        ownerReferences: [ownerRef(recreated.item)],
      },
    });
    assert.notEqual((await recreated.store.get<AgentRun>("AgentRun", "default", recreated.caller.metadata.name))?.metadata.uid, originalUid);
    await assert.rejects(recreated.submit("test", "recreated"), /active, current-round AgentRun/);
  } finally { recreated.db.close(); }

  const overlap = await fixture();
  try {
    await overlap.submit();
    await assert.rejects(overlap.submit("test", "another-request"), /another check is pending or running/);
    await assert.rejects(overlap.submit("test", "malformed", { ...overlap.origin, unexpected: true } as CheckWorkflowOrigin), /unexpected fields/);
  } finally { overlap.db.close(); }
});

test("controller runs only current active workflow jobs and rejects stale jobs without executing", async () => {
  const f = await fixture();
  const c = f.controller();
  try {
    const run = await f.submit();
    const item = (await f.store.get<WorkItem>("WorkItem", "default", "item"))!;
    await f.store.updateStatus({ ...item, status: { ...item.status!, stage: "implement", round: 4 } });
    await c.reconcile(keyOf(run));
    await c.stop();
    assert.equal(f.calls(), 0);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "NotVerified");
  } finally { await c.stop(); f.db.close(); }
});

test("workflow check execution is allowed while the matching item is Waiting", async () => {
  const f = await fixture();
  const item = (await f.store.get<WorkItem>("WorkItem", "default", "item"))!;
  await f.store.updateStatus({ ...item, status: { ...item.status!, phase: "Waiting" } });
  f.result({
    exitCode: 0,
    stdout: [
      { Action: "run", Package: "example/pkg", Test: "TestReady" },
      { Action: "pass", Package: "example/pkg", Test: "TestReady" },
    ].map((event) => JSON.stringify(event)).join("\n"),
    stderr: "", truncated: false, durationMs: 1, termination: { kind: "exit" },
  });
  const c = f.controller();
  try {
    const run = await f.submit();
    await c.reconcile(keyOf(run));
    await c.stop();
    assert.equal(f.calls(), 1);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "Passed");
  } finally { await c.stop(); f.db.close(); }
});

test("workflow check passes require a fresh tracked/non-ignored candidate snapshot", async () => {
  const f = await fixture({ format: "exit-code" });
  const c = f.controller({
    execute: async () => {
      f.snapshot("candidate-mutated");
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1, termination: { kind: "exit" } };
    },
  });
  try {
    const run = await f.submit();
    await c.reconcile(keyOf(run));
    await c.stop();
    const done = await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name);
    assert.equal(done?.status?.outcome, "NotVerified");
    assert.equal(done?.status?.finalSnapshot, "candidate-mutated");
  } finally { await c.stop(); f.db.close(); }
});

test("classification distinguishes assertion, preflight setup, generic, truncated and unsupported evidence", async () => {
  const perTestFailure = [
    { Action: "run", Package: "example/pkg", Test: "TestBroken" },
    { Action: "output", Package: "example/pkg", Test: "TestBroken", Output: "failure" },
    { Action: "fail", Package: "example/pkg", Test: "TestBroken" },
    { Action: "fail", Package: "example/pkg" },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 1, stdout: perTestFailure, stderr: "", truncated: false, durationMs: 1 }), "AssertionFailed");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 1, stdout: '{"Action":"fail","Package":"example/pkg"}', stderr: "", truncated: false, durationMs: 1 }), "UnknownFailure");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 }), "NotVerified");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 1, stdout: `${perTestFailure}\n{truncated`, stderr: "", truncated: false, durationMs: 1 }), "NotVerified");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 1, stdout: perTestFailure, stderr: "", truncated: true, durationMs: 1 }), "NotVerified");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 1, stdout: perTestFailure, stderr: "", truncated: false, durationMs: 1, termination: { kind: "timeout" } }), "TimedOut");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 143, stdout: perTestFailure, stderr: "", truncated: false, durationMs: 1, termination: { kind: "signal", signal: "SIGTERM" } }), "Cancelled");
  assert.equal(goTestJsonClassifier.classify({ exitCode: 127, stdout: "", stderr: "", truncated: false, durationMs: 1, termination: { kind: "spawn-error" } }), "Unavailable");
  assert.equal(exitCodeClassifier.classify({ exitCode: 2, stdout: "", stderr: "", truncated: false, durationMs: 1 }), "UnknownFailure");

  const setup = await fixture({ stage: "preflight", purpose: "preflight" });
  const preflightController = setup.controller();
  try {
    setup.result({ exitCode: 1, stdout: "setup failed", stderr: "", truncated: false, durationMs: 2, termination: { kind: "exit" } });
    const run = await setup.submit();
    await preflightController.reconcile(keyOf(run));
    await preflightController.stop();
    assert.equal((await setup.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "SetupFailed");
  } finally { await preflightController.stop(); setup.db.close(); }

  const assertion = await fixture();
  const assertionController = assertion.controller();
  try {
    assertion.result({ exitCode: 1, stdout: perTestFailure, stderr: "", truncated: false, durationMs: 2, termination: { kind: "exit" } });
    const run = await assertion.submit();
    await assertionController.reconcile(keyOf(run));
    await assertionController.stop();
    assert.equal((await assertion.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "AssertionFailed");
  } finally { await assertionController.stop(); assertion.db.close(); }

  const unknown = await fixture();
  const unknownController = unknown.controller();
  try {
    unknown.result({ exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 2, termination: { kind: "exit" } });
    const run = await unknown.submit("unknown");
    await unknownController.reconcile(keyOf(run));
    await unknownController.stop();
    assert.equal(unknown.calls(), 0);
    assert.equal((await unknown.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "NotVerified");
  } finally { await unknownController.stop(); unknown.db.close(); }
});

test("controller preserves termination precedence, enforces pinned config and never replays orphaned running checks", async () => {
  const f = await fixture({ format: "exit-code" });
  try {
    const timeoutController = f.controller();
    f.result({ exitCode: 137, stdout: "", stderr: "timed out", truncated: false, durationMs: 42, termination: { kind: "timeout", signal: "SIGKILL" } });
    const timedOut = await f.submit();
    await timeoutController.reconcile(keyOf(timedOut));
    await timeoutController.stop();
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", timedOut.metadata.name))?.status?.outcome, "TimedOut");
    await timeoutController.stop();

    const orphan = await f.submit("test", "orphan");
    const ref = await f.logs.open("default", { kind: "CheckRun", name: orphan.metadata.name });
    await f.store.updateStatus<CheckRun>({ ...orphan, status: { phase: "Running", logRef: ref } });
    const restartedController = f.controller();
    await restartedController.reconcile(keyOf(orphan));
    await restartedController.stop();
    await restartedController.reconcile(keyOf(orphan));
    assert.equal(f.calls(), 1);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", orphan.metadata.name))?.status?.phase, "Interrupted");
    await restartedController.stop();

    const changed = await f.submit("test", "changed-config");
    const repo = (await f.store.get<Repository>("Repository", "default", "repo"))!;
    await f.store.update({ ...repo, spec: { ...repo.spec, checks: { ...repo.spec.checks, test: { command: "replacement", timeoutMs: 99, resultFormat: "exit-code" } } } });
    const changedController = f.controller();
    await changedController.reconcile(keyOf(changed));
    await changedController.stop();
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", changed.metadata.name))?.status?.outcome, "NotVerified");
    assert.equal(f.calls(), 1);
    await changedController.stop();
    assert.deepEqual(f.errors, []);
  } finally { f.db.close(); }
});

test("admission rejects forged workflow ownership and accepts a scheduler-created pending CheckRun", async () => {
  const f = await fixture();
  try {
    const run = await f.submit();
    const validator = checkRunValidator();
    assert.deepEqual(await validator.validate(run, { operation: "CREATE", reader: f.store }), []);
    const forged = { ...run, metadata: { ...run.metadata, ownerReferences: [] } };
    assert.ok((await validator.validate(forged, { operation: "CREATE", reader: f.store })).some((error) => error.includes("owned")));
  } finally { f.db.close(); }
});

test("spawn failure is incomplete evidence; absent termination metadata and candidate mutation remain compatible", async () => {
  const scenarios: { result: ExecResult; outcome: string; incomplete: boolean; mutate?: boolean }[] = [
    { result: { exitCode: 127, stdout: "", stderr: "spawn failed", truncated: false, durationMs: 1, termination: { kind: "spawn-error" } },
      outcome: "Unavailable", incomplete: true },
    { result: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 },
      outcome: "Passed", incomplete: false },
    { result: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 },
      outcome: "NotVerified", incomplete: false, mutate: true },
  ];
  for (const scenario of scenarios) {
    const f = await fixture({ format: "exit-code" });
    const c = f.controller({
      execute: async () => {
        if (scenario.mutate) f.snapshot("changed-candidate");
        return scenario.result;
      },
    });
    try {
      const run = await f.submit();
      await c.reconcile(keyOf(run));
      await c.stop();
      const done = await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name);
      assert.equal(done?.status?.outcome, scenario.outcome);
      assert.equal(done?.status?.logsIncomplete, scenario.incomplete);
    } finally { await c.stop(); f.db.close(); }
  }
});

test("agent request ID is optional but is preserved and bound to idempotent caller requests when supplied", async () => {
  const f = await fixture();
  try {
    const { agentRequestId: _unused, ...withoutRequestId } = f.origin;
    const run = await f.submit("test", "optional-request-id", withoutRequestId);
    assert.equal(run.spec.workflow?.agentRequestId, undefined);
    assert.equal(run.spec.workflow?.agentRunUid, f.caller.metadata.uid);
    assert.equal((await f.submit("test", "optional-request-id", withoutRequestId)).metadata.uid, run.metadata.uid);
    await assert.rejects(f.submit("test", "optional-request-id", { ...withoutRequestId, agentRequestId: "different" }), /different input or origin/);
  } finally { f.db.close(); }
});
