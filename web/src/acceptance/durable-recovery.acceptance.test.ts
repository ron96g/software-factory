import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { FactoryApp, type FactoryAppDeps } from "../core/app/factory-app.ts";
import { AjvSchemaValidator } from "../core/adapters/schema/ajv.ts";
import { API_VERSION } from "../core/model/resource.ts";
import { ownerRef } from "../core/model/meta.ts";
import type { AgentRun, Artifact, ArtifactType, CheckRun, Repository, WorkItem, Workspace } from "../core/model/kinds.ts";
import type { RecoveryReport } from "../core/model/recovery.ts";
import { ANONYMOUS, type ArtifactCheck, type CheckRunScheduler, type CompiledWorkflow, type GateEvaluator, type VerificationContracts } from "../core/ports/index.ts";
import { Registry } from "../core/registry/registry.ts";
import { recoveryFailureSignature, ValidatedRecoveryRouter } from "../core/recovery/router.ts";
import { StoreEventRecorder } from "../core/runtime/event-recorder.ts";
import { createWorkItemController } from "../core/runtime/controllers/workitem.ts";
import { SqliteStore } from "../core/store/sqlite-store.ts";
import { UnitExecutionService } from "../core/units/service.ts";
import { humanApprovalGate } from "../core/workflow/gates.ts";
import { checkDefinitionVersion } from "../core/checks/definition-version.ts";

test("AC-39-3: partial Unit is diagnosed, repaired and checked before its normal human gate", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
    const store = new SqliteStore(db, clock);
    const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
      metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
      status: { phase: "Running", stage: "implement", step: 0, round: 1 } });
    const workspace = await store.create<Workspace>({ apiVersion: API_VERSION, kind: "Workspace",
      metadata: { name: "ws", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "item" }, status: { phase: "Ready", path: "/fake" } });
    const repo = await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository",
      metadata: { name: "repo", namespace: "factory-system" }, spec: { checks: { test: "test" },
        verification: { requiredChecks: ["test"], preflightChecks: [], readinessChecks: ["test"] } } });
    const unit = { id: "U1", title: "Deliver", dependsOn: [], criteria: ["AC-1"],
      obligations: [{ id: "O1", description: "Deliver", checks: ["repo/test"] }] };
    const verification = { planningStage: "plan", reviewStage: "plan-review", preflightStage: "preflight", verifyStage: "verify",
      implementationStage: "implement", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 0 };
    const stages = [
      { name: "implement", origin: "flow", lifecyclePhase: "construction", steps: [{ name: "developer", agentRef: { name: "developer" } }], gate: { type: "unit-progress" } },
      { name: "code-review", origin: "flow", lifecyclePhase: "construction", steps: [], gate: { type: "human-approval" } },
    ];
    const wf: CompiledWorkflow = { name: "flow", recovery: { version: "1", maxDiagnosisAttempts: 2, maxTotalAttempts: 5,
      humanNeedReserve: 1, maxOperatorAllowance: 2, diagnosticChecks: [] }, verification,
      unitExecution: { barrierStage: "code-review", maxCodeAttempts: 2, maxExecutionAttempts: 2 }, stages,
      stage: (name) => stages.find((s) => s.name === name), next: (name) => stages[stages.findIndex((s) => s.name === name) + 1] };
    const compiler = { compile: async () => wf };
    const contract = { fingerprint: "approved-plan", policy: verification, unitPolicy: wf.unitExecution,
      plan: { units: [unit], criteria: [], checks: ["repo/test"], preflight: [] }, repositories: [repo] };
    const contracts = { plan: async () => contract } as unknown as VerificationContracts;
    const schema = (parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType).spec.schema!;
    const router = new ValidatedRecoveryRouter({ reader: store, schemas: { get: async () => ({ ...schema, digest: "schema" }) },
      validator: new AjvSchemaValidator(), contracts });
    const checks: CheckRunScheduler = { submit: async (request) => store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun",
      metadata: { name: "readiness", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: workspace.metadata.uid!,
        repositoryRef: { name: "repo" }, repositoryVersion: checkDefinitionVersion(repo), check: request.check, command: "test", timeoutMs: 1000,
        snapshot: "tree", environment: { runtime: "fake", profileVersion: "default" }, requestedBy: "test", requestFingerprint: "readiness", workflow: request.workflow },
      status: { phase: "Completed", outcome: "Passed", finalSnapshot: "tree" } }) };
    const events = new StoreEventRecorder(store);
    const units = new UnitExecutionService({ namespace: "default", reader: store, compiler, contracts, scheduler: checks, events, clock,
      redactor: { redact: (s) => s }, candidates: { candidate: async () => ({ workspaces: [workspace], snapshots: { ws: "tree" },
        profiles: { repo: "default" }, health: { runtime: "fake", available: true }, fingerprint: "tree" }) },
      readers: { forWorkspaces: () => ({ readFile: async () => "code", listFiles: async () => [], searchCode: async () => [] }) } });
    const gates = new Registry<GateEvaluator>();
    gates.register(units.gate.type, units.gate);
    gates.register(humanApprovalGate.type, humanApprovalGate);
    const artifactChecks = new Registry<ArtifactCheck>();
    artifactChecks.register("recovery-report", { artifactType: "recovery-report", check: async (wi, artifact) => {
      const producer = await store.get<AgentRun>("AgentRun", "default", artifact.spec.producedBy!.agentRunRef.name);
      return router.validate(wi, producer!, JSON.parse(artifact.spec.content) as RecoveryReport);
    } });
    const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates,
      outbox: { enqueue: async () => { throw new Error("not used"); } }, workspaces: { supports: () => false },
      assignments: units, runFailures: units, artifactChecks, recovery: router });
    const app = new FactoryApp({ reader: store, writer: store, compiler, events } as unknown as FactoryAppDeps);
    const reconcile = () => controller.reconcile("default/item");
    const detail = async () => (await app.getWorkItem(ANONYMOUS, "item"))!;

    await reconcile();
    const initial = (await detail()).runs.find((r) => r.spec.assignment)!;
    const partial = await store.updateStatus<AgentRun>({ ...initial, status: { phase: "Succeeded", executor: "tool-loop", result: { outcome: "partial" } } });
    await reconcile(); await reconcile(); await reconcile(); await reconcile();
    const diagnosing = (await detail()).runs.find((r) => r.spec.recovery?.mode === "diagnosis")!;
    assert.ok(diagnosing);
    const episode = (await detail()).workItem.status!.recovery![0];
    const report: RecoveryReport = { schemaVersion: "1", episode: episode.id,
      trigger: { ...episode.trigger, resourceVersion: partial.metadata.resourceVersion! }, failureSignature: recoveryFailureSignature(partial),
      facts: ["Unit incomplete"], hypotheses: [], actions: [], obligations: ["O1"],
      evidence: [{ kind: "AgentRun", name: partial.metadata.name, resourceVersion: partial.metadata.resourceVersion! }], recommendation: "repair" };
    const artifact = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
      metadata: { name: "report", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: "recovery-report" }, producedBy: { agentRunRef: { name: diagnosing.metadata.name },
        agentRef: { name: "developer" } }, format: "json", content: JSON.stringify(report) } });
    await store.updateStatus<AgentRun>({ ...diagnosing, status: { phase: "Succeeded", executor: "tool-loop", outputs: [{ name: artifact.metadata.name }] } });
    await reconcile(); await reconcile();
    const repair = (await detail()).runs.find((r) => r.spec.recovery?.mode === "repair")!;
    assert.ok(repair);
    await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "unit-result", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: "unit-result" }, producedBy: { agentRunRef: { name: repair.metadata.name },
        agentRef: { name: "developer" } }, format: "json", content: JSON.stringify({ unit: "U1", outcome: "complete", obligations: [{ id: "O1", status: "done", evidence: [{ path: "code.ts" }] }] }) } });
    await store.updateStatus<AgentRun>({ ...repair, status: { phase: "Succeeded", executor: "tool-loop", result: { outcome: "complete" } } });
    for (let i = 0; i < 6; i++) await reconcile();
    const result = await detail();
    assert.equal(result.workItem.status?.phase, "AwaitingApproval");
    assert.equal(result.workItem.status?.stage, "code-review");
    assert.equal(result.clarifications.length, 0);
    assert.equal(result.approvals.length, 1);
  } finally { db.close(); }
});
