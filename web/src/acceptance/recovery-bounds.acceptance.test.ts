import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FactoryApp, type FactoryAppDeps } from "../core/app/factory-app.ts";
import type { AgentRun, Artifact, CheckRun, WorkItem } from "../core/model/kinds.ts";
import { ownerRef } from "../core/model/meta.ts";
import { API_VERSION } from "../core/model/resource.ts";
import { ANONYMOUS, type ArtifactCheck, type CompiledWorkflow, type RecoveryNeedHandler, type RecoveryRouter, type VerificationContracts } from "../core/ports/index.ts";
import { Registry } from "../core/registry/registry.ts";
import { RecoveryAllowances } from "../core/recovery/allowances.ts";
import { StoreEventRecorder } from "../core/runtime/event-recorder.ts";
import { createWorkItemController } from "../core/runtime/controllers/workitem.ts";
import { SqliteStore } from "../core/store/sqlite-store.ts";

async function fixture(route: "diagnose" | "human-need", wait = false) {
  const db = new DatabaseSync(":memory:");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const clock = { now: () => new Date(time) };
  const store = new SqliteStore(db, clock);
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
    metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
    status: { phase: "Running", stage: "implement", step: 1, round: 1 } });
  const trigger = await store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun", metadata: { name: "trigger", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: "ws",
      repositoryRef: { name: "repo" }, repositoryVersion: "1", check: "test", command: "test", timeoutMs: 1000, snapshot: "tree",
      environment: { runtime: "runtime", profileVersion: "1" }, requestedBy: "test", requestFingerprint: "x" },
    status: { phase: "Completed", outcome: "Unavailable" } });
  const ep = { id: "episode", workItemUid: item.metadata.uid!, planFingerprint: "plan", unit: "U1", stage: "implement", policyVersion: "1",
    maxTotalAttempts: 5, operatorAllowance: 0, trigger: { kind: "CheckRun" as const, name: "trigger", uid: trigger.metadata.uid! },
    diagnosticAttempts: 2, codeAttempts: 0, executionAttempts: 0, disposition: "diagnosing" as const };
  await store.updateStatus({ ...item, status: { ...item.status!, recovery: [ep] } });
  const report = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "report", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: "recovery-report" },
      producedBy: { agentRunRef: { name: "item-recovery-episode-d2" }, agentRef: { name: "developer" } }, format: "json", content: JSON.stringify({
      episode: "episode", trigger: { kind: "CheckRun", name: "trigger", uid: trigger.metadata.uid, resourceVersion: trigger.metadata.resourceVersion },
    }) } });
  await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
    metadata: { name: "item-recovery-episode-d2", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, skillRefs: [], stage: "implement", step: "diagnosis",
      inputs: [], outputs: [{ name: "recovery-report" }] },
    status: { phase: "Succeeded", executor: "tool-loop", outputs: [{ name: report.metadata.name }] } });
  const stages = [{ name: "implement", lifecyclePhase: "construction", origin: "flow", steps: [{ name: "developer", agentRef: { name: "developer" } }] }];
  const wf: CompiledWorkflow = { name: "flow", recovery: { version: "1", maxDiagnosisAttempts: 2, maxTotalAttempts: 5,
    humanNeedReserve: 1, maxOperatorAllowance: 2, diagnosticChecks: [] },
    ...(wait ? { unitExecution: { barrierStage: "review", maxCodeAttempts: 1, maxExecutionAttempts: 2 },
      verification: { planningStage: "plan", reviewStage: "plan-review", preflightStage: "preflight", verifyStage: "verify",
        implementationStage: "implement", maxCodeAttempts: 1, maxExecutionAttempts: 2, retryDelayMs: 1000 } } : {}),
    stages, stage: (name) => stages.find((s) => s.name === name), next: () => undefined };
  const compiler = { compile: async () => wf };
  let restored = false;
  const need = { kind: "sandbox-runtime" as const, runtime: "runtime", need: "Restore the permitted runtime?",
    options: ["Restore runtime", "Stop"], recommendation: "Restore runtime" };
  const needs = new Registry<RecoveryNeedHandler>();
  needs.register("sandbox-runtime", { type: "sandbox-runtime", inspect: async () => restored ? "satisfied" : "needed",
    resolve: ({ answer }) => answer === "Restore runtime" ? "resume" : answer === "Stop" ? "stop" : "invalid" });
  const router: RecoveryRouter = { signature: () => "signature", route: async () => route === "diagnose" ? { action: "diagnose" } : { action: "human-need", need } };
  const checks = new Registry<ArtifactCheck>();
  checks.register("recovery-report", { artifactType: "recovery-report", check: async () => undefined });
  const events = new StoreEventRecorder(store);
  const allowances = new RecoveryAllowances({ namespace: "default", reader: store, writer: store, compiler,
    contracts: { plan: async () => ({ fingerprint: "plan" }) } as unknown as VerificationContracts,
    schemas: { get: async () => ({ version: "1", jsonSchema: {}, digest: "fake" }) }, validator: { validate: () => undefined } });
  const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler,
    gates: new Registry(), outbox: { enqueue: async () => { throw new Error("not used"); } }, workspaces: { supports: () => false },
    artifactChecks: checks, recovery: router, recoveryNeeds: needs, recoveryAllowances: allowances,
    assignments: { assign: async () => ({ kind: "unit", planFingerprint: "plan", unit: "U1" }) } });
  const app = new FactoryApp({ reader: store, writer: store, compiler, events } as unknown as FactoryAppDeps);
  return { db, store, app, allowances, reconcile: () => controller.reconcile("default/item"), restore: () => { restored = true; },
    advance: (milliseconds: number) => { time += milliseconds; } };
}

test("AC-39-4: exhausted diagnostic history stays bounded after duplicate reconciliation and restart", async () => {
  const f = await fixture("diagnose");
  try {
    await f.reconcile(); await f.reconcile();
    let detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.equal(detail.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
    assert.equal(detail.clarifications.length, 0);
    await f.store.update({ ...detail.workItem, spec: { ...detail.workItem.spec, restart: { id: "restart", requestedAt: "2026-01-01T00:00:00Z" } } });
    await f.reconcile(); await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
  } finally { f.db.close(); }
});

test("AC-39-4: execution recovery retains its mode after an earlier code repair", async () => {
  const f = await fixture("diagnose");
  try {
    const item = (await f.app.getWorkItem(ANONYMOUS, "item"))!.workItem;
    await f.store.updateStatus({ ...item, status: { ...item.status!, step: 0, recovery: item.status!.recovery!.map((episode) => ({
      ...episode, disposition: "repairing" as const, codeAttempts: 1, executionAttempts: 1, nextAttemptMode: "execution-recovery" as const,
    })) } });
    await f.reconcile();
    const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    const run = detail.runs.find((r) => r.spec.recovery?.mode === "execution-recovery");
    assert.ok(run);
    assert.equal(run.spec.recovery?.attempt, 2);
  } finally { f.db.close(); }
});

test("AC-39-7: an authorized allowance is consumed once and resumes only its bound episode", async () => {
  const f = await fixture("diagnose");
  try {
    await f.reconcile();
    const operator = { id: "operator", roles: ["operator"], squads: [] };
    const request = await f.allowances.request(operator, "item", { requestId: "allocation-1", count: 1, target: "diagnosis", reason: "Repaired the infrastructure" });
    await f.allowances.decide(operator, request.metadata.name, "approve", "Reviewed the recovery evidence");
    await f.reconcile(); await f.reconcile();
    const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    const episode = detail.workItem.status!.recovery![0];
    assert.equal(episode.operatorAllowance, 1);
    assert.deepEqual(episode.consumedAllowances, [request.metadata.name]);
    assert.equal(episode.diagnosticAttempts, 3);
    assert.equal(detail.runs.filter((r) => r.metadata.name.endsWith("-d3")).length, 1);
    await assert.rejects(f.allowances.decide(operator, request.metadata.name, "approve", "Reviewed the recovery evidence"), /already decided/);
  } finally { f.db.close(); }
});

test("AC-39-7: stale approved allocation is recorded once rather than repeatedly reconciled", async () => {
  const f = await fixture("diagnose");
  try {
    await f.reconcile();
    const operator = { id: "operator", roles: ["operator"], squads: [] };
    const approval = await f.allowances.request(operator, "item", { requestId: "stale", count: 1, target: "diagnosis", reason: "Repaired the infrastructure" });
    await f.allowances.decide(operator, approval.metadata.name, "approve", "Reviewed the recovery evidence");
    const report = (await f.store.get<Artifact>("Artifact", "default", "report"))!;
    await f.store.update({ ...report, spec: { ...report.spec, content: '{"episode":"changed"}' } });
    await f.reconcile(); await f.reconcile();
    const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.deepEqual(detail.workItem.status?.staleRecoveryAllowances, [approval.metadata.name]);
    assert.equal(detail.events.filter((event) => event.spec.reason === "RecoveryAllowanceStale").length, 1);
    assert.equal(detail.workItem.status?.recovery?.[0].operatorAllowance, 0);
  } finally { f.db.close(); }
});

test("AC-39-7: operator repair allocation cannot override the authoritative diagnosis route", async () => {
  const f = await fixture("diagnose");
  try {
    await f.reconcile();
    const operator = { id: "operator", roles: ["operator"], squads: [] };
    const approval = await f.allowances.request(operator, "item", { requestId: "repair", count: 1, target: "repair", reason: "Reviewed the apparent code failure" });
    await f.allowances.decide(operator, approval.metadata.name, "approve", "Approved a bounded code attempt");
    await f.reconcile(); await f.reconcile();
    const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.deepEqual(detail.workItem.status?.staleRecoveryAllowances, [approval.metadata.name]);
    assert.equal(detail.workItem.status?.recovery?.[0].codeAttempts, 0);
    assert.equal(detail.workItem.status?.recovery?.[0].operatorAllowance, 0);
  } finally { f.db.close(); }
});

test("AC-39-7: answering a genuine need does not spend the reserve until the runtime is restored", async () => {
  const f = await fixture("human-need");
  try {
    await f.reconcile();
    let detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Blocked");
    assert.equal(detail.clarifications.length, 1);
    await f.app.answerClarification(ANONYMOUS, detail.clarifications[0].metadata.name, ["Restore runtime"]);
    await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
    assert.equal(detail.workItem.status?.phase, "Blocked");
    f.restore();
    await f.reconcile(); await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.recovery?.[0].diagnosticAttempts, 3);
    assert.ok(detail.workItem.status?.recovery?.[0].humanNeedConsumed);
    assert.equal(detail.clarifications.length, 1);
  } finally { f.db.close(); }
});

test("AC-39-7: runtime unavailability waits with durable bounded backoff before requesting a human", async () => {
  const f = await fixture("human-need", true);
  try {
    await f.reconcile();
    let detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Waiting");
    assert.equal(detail.workItem.status?.recovery?.[0].runtimeWaits, 1);
    const first = detail.workItem.status?.recovery?.[0].retryAt;
    await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.recovery?.[0].retryAt, first);
    assert.equal(detail.clarifications.length, 0);
    f.advance(1000); await f.reconcile(); await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Waiting");
    assert.equal(detail.workItem.status?.recovery?.[0].runtimeWaits, 2);
    f.advance(2000); await f.reconcile(); await f.reconcile();
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Blocked");
    assert.equal(detail.clarifications.length, 1);
    assert.equal(detail.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
  } finally { f.db.close(); }
});
