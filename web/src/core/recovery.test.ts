import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { AjvSchemaValidator } from "./adapters/schema/ajv.ts";
import type { AgentRun, ArtifactType, CheckRun, WorkItem, WorkflowSpec } from "./model/kinds.ts";
import { recoveryPolicyProblems } from "./model/recovery-policy.ts";
import type { RecoveryEpisode, RecoveryReport } from "./model/recovery.ts";
import type { ResourceReader } from "./ports/store.ts";
import { recoveryFailureSignature, ValidatedRecoveryRouter } from "./recovery/router.ts";
import { createWorkItemController, type WorkItemControllerDeps } from "./runtime/controllers/workitem.ts";

test("recovery report schema compiles in strict mode and enforces a genuine options shape", () => {
  const definition = parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType;
  const schema = definition.spec.schema!.jsonSchema;
  const validator = new AjvSchemaValidator();
  const report: RecoveryReport = { schemaVersion: "1", episode: "episode", trigger: { kind: "CheckRun", name: "check", uid: "u", resourceVersion: "1" },
    failureSignature: "hash", facts: [], hypotheses: [], actions: [], obligations: [], evidence: [{ kind: "CheckRun", name: "check", resourceVersion: "1" }],
    recommendation: "human-need", humanNeed: { kind: "sandbox-runtime", runtime: "runtime", need: "Restore runtime", options: ["Restore runtime", "Stop"], recommendation: "Restore runtime" } };
  assert.equal(validator.validate(schema, report), undefined);
  assert.match(validator.validate(schema, { ...report, humanNeed: undefined })!, /humanNeed/);
  assert.match(validator.validate(schema, { ...report, extra: true })!, /additional properties/);
});

test("opt-in policy rejects malformed or unlimited budgets and needs a Unit contract", () => {
  const recovery = { version: "1", maxTotalAttempts: 6, humanNeedReserve: 1 as const, maxOperatorAllowance: 2, diagnosticChecks: ["repo/unit-tests"] };
  const valid = { recovery, verification: {}, unitExecution: {} } as WorkflowSpec;
  assert.deepEqual(recoveryPolicyProblems(valid), []);
  assert.ok(recoveryPolicyProblems({ ...valid, recovery: { ...recovery, maxTotalAttempts: 0 } }).length);
  assert.ok(recoveryPolicyProblems({ ...valid, recovery: { ...recovery, diagnosticChecks: ["repo/unit-tests", "repo/unit-tests"] } }).length);
  assert.ok(recoveryPolicyProblems({ recovery } as WorkflowSpec).length);
  assert.deepEqual(recoveryPolicyProblems({} as WorkflowSpec), []);
});

test("opt-in recovery fails closed until durable orchestration is wired", async () => {
  let item = { kind: "WorkItem", metadata: { name: "item", uid: "wi", namespace: "default" },
    spec: { workflowRef: { name: "flow" } }, status: { phase: "New" } } as WorkItem;
  const deps = {
    reader: { get: async () => item },
    compiler: { compile: async () => ({ recovery: { version: "1" } }) },
    status: { updateStatus: async (value: WorkItem) => { item = value; return value; } },
    events: { normal: async () => undefined },
    clock: { now: () => new Date("2026-01-01T00:00:00Z") },
  } as unknown as WorkItemControllerDeps;
  await createWorkItemController(deps).reconcile("default/item");
  assert.equal(item.status?.phase, "Failed");
  assert.match(item.status?.message ?? "", /durable recovery controller is not wired/);
});

test("routing rejects stale evidence and never lets model prose reclassify UnknownFailure", async () => {
  const owner = { kind: "WorkItem", name: "item", uid: "wi-uid" };
  const meta = (name: string, uid: string) => ({ name, uid, namespace: "default", resourceVersion: "1", ownerReferences: [owner] });
  const check = { kind: "CheckRun", metadata: meta("check", "check-uid"), spec: { check: "unit-tests", workItemUid: "wi-uid", workflow: { planFingerprint: "plan", unit: "U1" } },
    status: { phase: "Completed", outcome: "UnknownFailure" } } as CheckRun;
  const episode: RecoveryEpisode = { id: "episode", workItemUid: "wi-uid", planFingerprint: "plan", unit: "U1", policyVersion: "1", stage: "implement", maxTotalAttempts: 6, operatorAllowance: 0,
    trigger: { kind: "CheckRun", name: "check", uid: "check-uid" }, diagnosticAttempts: 1, codeAttempts: 0, executionAttempts: 0, disposition: "diagnosing" };
  const item = { kind: "WorkItem", metadata: { name: "item", uid: "wi-uid", namespace: "default" }, status: { phase: "Running", recovery: [episode] } } as WorkItem;
  const run = { kind: "AgentRun", metadata: meta("diagnosis", "run-uid"), spec: { recovery: { episode: "episode", attempt: 1, mode: "diagnosis",
    planFingerprint: "plan", unit: "U1", policyVersion: "1", trigger: episode.trigger } } } as AgentRun;
  const reader = { get: async (kind: string, _ns: string, name: string) => kind === "CheckRun" && name === "check" ? check : null,
    list: async () => [] } as unknown as ResourceReader;
  const definition = parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType;
  const router = new ValidatedRecoveryRouter({ reader,
    schemas: { get: async () => ({ ...definition.spec.schema!, digest: "digest" }) }, validator: new AjvSchemaValidator(),
    contracts: { plan: async () => ({ fingerprint: "plan" }) as never } });
  const report: RecoveryReport = { schemaVersion: "1", episode: "episode", trigger: { ...episode.trigger, resourceVersion: "1" },
    failureSignature: recoveryFailureSignature(check), facts: [], hypotheses: [], actions: [], obligations: [],
    evidence: [{ kind: "CheckRun", name: "check", resourceVersion: "1" }], recommendation: "repair" };
  const policy = { version: "1", maxTotalAttempts: 6, humanNeedReserve: 1 as const, maxOperatorAllowance: 2, diagnosticChecks: [] };
  assert.match((await router.route({ item, episode, policy, run, report }) as { reason: string }).reason, /cannot reclassify/);
  check.status!.outcome = "AssertionFailed";
  report.failureSignature = recoveryFailureSignature(check);
  assert.deepEqual(await router.route({ item, episode, policy, run, report }), { action: "repair" });
  report.evidence[0].resourceVersion = "old";
  assert.match((await router.route({ item, episode, policy, run, report }) as { reason: string }).reason, /stale/);
  report.evidence[0].resourceVersion = "1";
  report.codeEvidence = [{ repository: "repo", path: "src/example.ts", startLine: 1, endLine: 2, snapshot: "snapshot" }];
  const workspace = { metadata: { name: "ws" }, spec: { repositoryRef: { name: "repo" } } };
  const codeRouter = new ValidatedRecoveryRouter({ reader,
    schemas: { get: async () => ({ ...definition.spec.schema!, digest: "digest" }) }, validator: new AjvSchemaValidator(),
    contracts: { plan: async () => ({ fingerprint: "plan", repositories: [{ metadata: { name: "repo" } }] }) as never },
    candidates: { candidate: async () => ({ workspaces: [workspace], snapshots: { ws: "snapshot" } }) } as never,
    readers: { forWorkspaces: () => ({ readFile: async () => "one\ntwo" }) } as never });
  assert.deepEqual(await codeRouter.route({ item, episode, policy, run, report }), { action: "repair" });
  report.codeEvidence[0].snapshot = "old";
  assert.match((await codeRouter.route({ item, episode, policy, run, report }) as { reason: string }).reason, /stale/);
  report.codeEvidence[0].snapshot = "snapshot";
  report.codeEvidence[0].endLine = 3;
  assert.match((await codeRouter.route({ item, episode, policy, run, report }) as { reason: string }).reason, /line count/);
});
