import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { AjvSchemaValidator } from "../core/adapters/schema/ajv.ts";
import { FactoryApp, type FactoryAppDeps } from "../core/app/factory-app.ts";
import { persistedArtifactCheck, schemaArtifactCheck } from "../core/artifacts/output-checks.ts";
import type { AgentRun, Artifact, ArtifactType, CheckRun, WorkItem } from "../core/model/kinds.ts";
import { ownerRef } from "../core/model/meta.ts";
import type { RecoveryEpisode, RecoveryReport } from "../core/model/recovery.ts";
import { API_VERSION } from "../core/model/resource.ts";
import { ANONYMOUS, type ArtifactCheck, type CompiledWorkflow, type VerificationContracts } from "../core/ports/index.ts";
import { Registry } from "../core/registry/registry.ts";
import { recoveryFailureSignature, ValidatedRecoveryRouter } from "../core/recovery/router.ts";
import { createWorkItemController } from "../core/runtime/controllers/workitem.ts";
import { StoreEventRecorder } from "../core/runtime/event-recorder.ts";
import { SqliteStore } from "../core/store/sqlite-store.ts";

async function exercise(extra: "none" | "unrelated" | "baseline" | "relevant", maximum = 10) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
  const store = new SqliteStore(db, clock);
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
    metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
    status: { phase: "Running", stage: "implement", step: 0, round: 1 } });
  const check = (name: string, test: string, snapshot: string, purpose: "unit-readiness" | "diagnostic" | "baseline" = "unit-readiness",
    failedTest = "A") => store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun",
    metadata: { name, namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: "ws",
      repositoryRef: { name: "repo" }, repositoryVersion: "1", check: test, command: "trusted-test", timeoutMs: 1000, snapshot,
      environment: { runtime: "runtime", profileVersion: "1" }, requestedBy: name, requestFingerprint: name,
      workflow: { stage: "implement", round: 1, purpose, planFingerprint: "plan", unit: "U1", attempt: 1 } },
    status: { phase: "Completed", outcome: "AssertionFailed", exitCode: 1, message: `volatile wording ${name}`, failureEvidence: { tests: [failedTest] } } });
  const first = await check("first", "test", "tree-a");
  const second = await check("second", "test", "tree-b");
  assert.equal(recoveryFailureSignature(first), recoveryFailureSignature(second), "caller, snapshot, name and wording do not change the failure");
  const policy = { version: "1", maxDiagnosisAttempts: 2, maxTotalAttempts: maximum, humanNeedReserve: 0 as const, maxOperatorAllowance: 1, diagnosticChecks: [] };
  const stages = [{ name: "implement", lifecyclePhase: "construction", origin: "flow", steps: [{ name: "developer", agentRef: { name: "developer" } }] }];
  const wf: CompiledWorkflow = { name: "flow", recovery: policy,
    unitExecution: { barrierStage: "review", maxCodeAttempts: 3, maxExecutionAttempts: 3 },
    stages, stage: (name) => stages.find((s) => s.name === name), next: () => undefined };
  const compiler = { compile: async () => wf };
  const contracts = { plan: async () => ({ fingerprint: "plan", repositories: [] }) } as unknown as VerificationContracts;
  const schema = (parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType).spec.schema!;
  const schemas = { get: async () => ({ ...schema, digest: "schema" }) };
  const router = new ValidatedRecoveryRouter({ reader: store, schemas, validator: new AjvSchemaValidator(), contracts });
  const proposed = schemaArtifactCheck("recovery-report", schemas, new AjvSchemaValidator(), router.artifactCheck);
  const checks = new Registry<ArtifactCheck>();
  checks.register("recovery-report", persistedArtifactCheck(proposed, { reader: store, readers: { forWorkspaces: () => ({
    readFile: async () => "", listFiles: async () => [], searchCode: async () => [] }) } }));
  const controller = createWorkItemController({ reader: store, writer: store, status: store, clock, compiler,
    events: new StoreEventRecorder(store), gates: new Registry(), outbox: { enqueue: async () => { throw new Error("not used"); } },
    workspaces: { supports: () => false }, artifactChecks: checks, recovery: router });
  const app = new FactoryApp({ reader: store, writer: store, compiler, events: new StoreEventRecorder(store) } as unknown as FactoryAppDeps);
  const newEpisode = (id: string, trigger: CheckRun): RecoveryEpisode => ({ id, workItemUid: item.metadata.uid!, planFingerprint: "plan",
    unit: "U1", policyVersion: "1", stage: "implement", maxTotalAttempts: maximum, operatorAllowance: 0, diagnosticAttempts: 1,
    codeAttempts: 0, executionAttempts: 0, trigger: { kind: "CheckRun", name: trigger.metadata.name, uid: trigger.metadata.uid! },
    failureSignature: recoveryFailureSignature(trigger), disposition: "diagnosing" });
  async function report(ep: RecoveryEpisode, trigger: CheckRun, extraCheck?: CheckRun) {
    const name = `item-recovery-${ep.id}-d1`;
    const run = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, skillRefs: [], stage: "implement", step: `diagnosis-${ep.id}`,
        inputs: [], outputs: [{ name: "recovery-report" }], assignment: { kind: "unit", planFingerprint: "plan", unit: "U1" },
        recovery: { episode: ep.id, attempt: 1, mode: "diagnosis", planFingerprint: "plan", unit: "U1", policyVersion: "1", trigger: ep.trigger } } });
    const refs = [trigger, ...(extraCheck ? [extraCheck] : [])];
    const body: RecoveryReport = { schemaVersion: "1", episode: ep.id, trigger: { ...ep.trigger, resourceVersion: trigger.metadata.resourceVersion! },
      failureSignature: recoveryFailureSignature(trigger), facts: ["different model wording"], hypotheses: [], actions: [], obligations: [],
      evidence: refs.map((r) => ({ kind: "CheckRun", name: r.metadata.name, resourceVersion: r.metadata.resourceVersion! })), recommendation: "repair" };
    const artifact = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
      metadata: { name: `report-${ep.id}`, namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: "recovery-report" },
        producedBy: { agentRunRef: { name }, agentRef: { name: "developer" } }, format: "json", content: JSON.stringify(body) } });
    await store.updateStatus({ ...run, status: { phase: "Succeeded", executor: "tool-loop", outputs: [{ name: artifact.metadata.name }] } });
  }
  try {
    const ep1 = newEpisode("one", first);
    await store.updateStatus({ ...item, status: { ...item.status!, recovery: [ep1] } });
    await report(ep1, first);
    await controller.reconcile("default/item");
    const afterFirst = (await app.getWorkItem(ANONYMOUS, "item"))!.workItem;
    assert.equal(afterFirst.status?.recovery?.[0].disposition, "repairing");
    const ep2 = newEpisode("two", second);
    await store.updateStatus({ ...afterFirst, status: { ...afterFirst.status!, phase: "Running", stage: "implement", step: 0,
      recovery: [{ ...afterFirst.status!.recovery![0], disposition: "resolved" }, ep2] } });
    const evidence = extra === "unrelated" ? await check("other", "other", "tree-b", "diagnostic", "B") :
      extra === "baseline" ? await check("base", "test", "tree-b", "baseline", "B") :
      extra === "relevant" ? await check("new-test-failure", "test", "tree-b", "diagnostic", "B") : undefined;
    await report(ep2, second, evidence);
    await controller.reconcile("default/item");
    return { db, store, app, controller };
  } catch (error) { db.close(); throw error; }
}

for (const kind of ["none", "unrelated", "baseline"] as const) {
  test(`AC-39-4: ${kind} evidence cannot reopen a blind repair across a new episode and candidate`, async () => {
    const f = await exercise(kind);
    try {
      const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
      assert.equal(detail.workItem.status?.recovery?.[1].disposition, "diagnosing");
      assert.equal(detail.workItem.status?.recovery?.[1].diagnosticAttempts, 2);
      assert.equal(detail.workItem.status?.recovery?.[1].codeAttempts, 0);
    } finally { f.db.close(); }
  });
}

test("AC-39-4: a distinct authoritative failure of the same named check can justify a bounded repair", async () => {
  const f = await exercise("relevant");
  try {
    const detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.recovery?.[1].disposition, "repairing");
    assert.equal(detail.workItem.status?.recovery?.[1].codeAttempts, 1);
  } finally { f.db.close(); }
});

test("AC-39-4: new episode, trigger and caller cannot reset aggregate budget, including after restart", async () => {
  const f = await exercise("none", 3);
  try {
    let detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.match(detail.workItem.status?.message ?? "", /unchanged/);
    const used = detail.workItem.status!.recovery!.map((e) => [e.diagnosticAttempts, e.codeAttempts, e.executionAttempts]);
    await f.store.update({ ...detail.workItem, spec: { ...detail.workItem.spec, restart: { id: "again", requestedAt: "2026-01-01T00:00:00Z" } } });
    await f.controller.reconcile("default/item");
    detail = (await f.app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "Failed");
    assert.deepEqual(detail.workItem.status!.recovery!.map((e) => [e.diagnosticAttempts, e.codeAttempts, e.executionAttempts]), used);
  } finally { f.db.close(); }
});
