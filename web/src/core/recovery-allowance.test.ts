import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { AjvSchemaValidator } from "./adapters/schema/ajv.ts";
import type { Approval, Artifact, ArtifactType, CheckRun, WorkItem } from "./model/kinds.ts";
import { ownerRef } from "./model/meta.ts";
import { API_VERSION } from "./model/resource.ts";
import { ANONYMOUS, type VerificationContracts } from "./ports/index.ts";
import { RecoveryAllowances } from "./recovery/allowances.ts";
import { runtimeRecoveryNeed } from "./recovery/runtime-need.ts";
import { SqliteStore } from "./store/sqlite-store.ts";

test("operator allowance binds exact report and rejects unauthorized, duplicate and stale decisions", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new SqliteStore(db, { now: () => new Date("2026-01-01T00:00:00Z") });
    const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
      metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
      status: { phase: "Failed" } });
    const trigger = await store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun",
      metadata: { name: "check", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, workItemUid: item.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: "ws",
        repositoryRef: { name: "repo" }, repositoryVersion: "1", check: "test", command: "test", timeoutMs: 1000, snapshot: "tree",
        environment: { runtime: "runtime", profileVersion: "1" }, requestedBy: "test", requestFingerprint: "x" },
      status: { phase: "Completed", outcome: "Unavailable" } });
    const report = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
      metadata: { name: "report", namespace: "default", ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: "recovery-report" }, format: "json", content: JSON.stringify({
        schemaVersion: "1", episode: "ep", trigger: { kind: "CheckRun", name: "check", uid: trigger.metadata.uid!, resourceVersion: trigger.metadata.resourceVersion! },
        failureSignature: "signature", facts: [], hypotheses: [], actions: [], obligations: [],
        evidence: [{ kind: "CheckRun", name: "check", resourceVersion: "1" }], recommendation: "stop",
      }) } });
    await store.updateStatus({ ...item, status: { phase: "Failed", recovery: [{ id: "ep", workItemUid: item.metadata.uid!,
      planFingerprint: "plan", unit: "U1", stage: "implement", policyVersion: "1", maxTotalAttempts: 4, operatorAllowance: 0,
      trigger: { kind: "CheckRun" as const, name: "check", uid: trigger.metadata.uid! }, diagnosticAttempts: 2, codeAttempts: 1, executionAttempts: 0,
      latestReport: { name: report.metadata.name, resourceVersion: report.metadata.resourceVersion! }, disposition: "failed" as const }] } });
    const policy = { version: "1", maxTotalAttempts: 4, humanNeedReserve: 1 as const, maxOperatorAllowance: 1, diagnosticChecks: [] };
    const compiler = { compile: async () => ({ recovery: policy }) } as never;
    const contracts = { plan: async () => ({ fingerprint: "plan" }) } as unknown as VerificationContracts;
    const definition = parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType;
    const service = new RecoveryAllowances({ namespace: "default", reader: store, writer: store, compiler, contracts,
      schemas: { get: async () => ({ ...definition.spec.schema!, digest: "digest" }) }, validator: new AjvSchemaValidator() });
    const operator = { id: "operator-1", roles: ["operator"], squads: [] };
    const request = { requestId: "request-1", count: 1, target: "diagnosis" as const, reason: "Investigate after infrastructure repair" };
    await assert.rejects(service.request(ANONYMOUS, "item", request), /authority/);
    const invalid = await store.update({ ...report, spec: { ...report.spec, content: "{}" } });
    const failed = (await store.get<WorkItem>("WorkItem", "default", "item"))!;
    const episode = failed.status!.recovery![0];
    const invalidItem = await store.updateStatus({ ...failed, status: { ...failed.status!, recovery: [{ ...episode,
      latestReport: { name: invalid.metadata.name, resourceVersion: invalid.metadata.resourceVersion! } }] } });
    await assert.rejects(service.request(operator, "item", request), /invalid/);
    const restored = await store.update({ ...invalid, spec: { ...invalid.spec, content: report.spec.content } });
    await store.updateStatus({ ...invalidItem, status: { ...invalidItem.status!, recovery: [{ ...episode,
      latestReport: { name: restored.metadata.name, resourceVersion: restored.metadata.resourceVersion! } }] } });
    const approval = await service.request(operator, "item", request);
    assert.equal((await service.request(operator, "item", request)).metadata.uid, approval.metadata.uid);
    await assert.rejects(service.request(operator, "item", { ...request, reason: "Different reason entirely" }), /different input/);
    await assert.rejects(service.decide(ANONYMOUS, approval.metadata.name, "approve", "Investigated the failure"), /authority/);
    await service.decide(operator, approval.metadata.name, "reject", "Investigation is not finished");
    const second = await service.request(operator, "item", { ...request, requestId: "request-2" });
    assert.notEqual(second.metadata.name, approval.metadata.name);
    assert.equal((await service.request(operator, "item", request)).spec.decision, "reject");
    await store.update({ ...restored, spec: { ...restored.spec, content: "{\"changed\":true}" } });
    await assert.rejects(service.decide(operator, second.metadata.name, "approve", "Investigated the failure"), /stale/);
    const untouched = await store.get<Approval>("Approval", "default", second.metadata.name);
    assert.equal(untouched?.spec.decision, undefined);
  } finally { db.close(); }
});

test("runtime need is independently checked again after an answer", async () => {
  let available = false;
  const environments = { refresh: async () => {}, select: async () => ({ candidates: [{ runtime: "runtime", available, isolation: "container" }] }) } as never;
  const need = { kind: "sandbox-runtime" as const, runtime: "runtime", need: "Restore the runtime", options: ["Restore runtime", "Stop"], recommendation: "Restore runtime" };
  const trigger = { kind: "CheckRun", spec: { environment: { runtime: "runtime" } }, status: { outcome: "Unavailable" } } as CheckRun;
  const handler = runtimeRecoveryNeed(environments);
  const item = {} as WorkItem;
  assert.equal(await handler.inspect({ item, trigger, need }), "needed");
  assert.equal(await handler.inspect({ item, trigger, need }), "needed", "an answer alone does not change health");
  available = true;
  assert.equal(await handler.inspect({ item, trigger, need }), "satisfied");
  assert.equal(await handler.inspect({ item, trigger, need: { ...need, runtime: "other" } }), "invalid");
});
