import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRun, CheckRun, OutboxMessage, WorkItem } from "../core/model/kinds.ts";
import type { WorkItemDetail } from "../core/ports/app.ts";
import { deriveStageState } from "./stage-state.ts";

const item = (status: WorkItem["status"]): WorkItem => ({ apiVersion: "v", kind: "WorkItem", metadata: { name: "item" }, spec: { title: "t", sourceRef: { name: "manual" } }, status });
const detail = (status: WorkItem["status"], extra: Partial<WorkItemDetail> = {}): WorkItemDetail => ({
  workItem: item(status), runs: [], artifacts: [], clarifications: [], approvals: [], conversations: [], workspaces: [], outbox: [],
  evidence: { items: [] } as unknown as WorkItemDetail["evidence"], events: [], knowledge: [], issues: [],
  stages: [
    { name: "verify", lifecyclePhase: "construction", gate: "verified-checks", steps: [{ name: "verify-against-spec", agent: "verifier" }] },
    { name: "ship", lifecyclePhase: "operations", gate: "human-approval", steps: [], publishes: true },
  ],
  repositories: [{ name: "controlplane", publishable: false }, { name: "software-factory", publishable: true }],
  ...extra,
});
const run = (name: string, stage: string, step: string, status: AgentRun["status"]): AgentRun =>
  ({ apiVersion: "v", kind: "AgentRun", metadata: { name }, spec: { stage, step, agentRef: { name: "a" } }, status } as unknown as AgentRun);
const pr = (status: OutboxMessage["status"]): OutboxMessage =>
  ({ apiVersion: "v", kind: "OutboxMessage", metadata: { name: "item-ship-r31-pr-software-factory" }, spec: { action: "open-pull-request", payload: {} }, status } as unknown as OutboxMessage);

test("a stage waiting on unavailable agent tools says it won't resolve by itself", () => {
  const d = detail({ phase: "Waiting", stage: "verify", round: 30, message: "Waiting instead of simulating: agent tools [shell] are not available (ADR-0019)." },
    { runs: [run("item-verify-0-r30", "verify", "verify-against-spec", { phase: "Pending" })] });
  const s = deriveStageState(d, [], "verify");
  assert.equal(s.status, "active");
  assert.match(s.waitingFor!, /agent tools \[shell\] are not available/);
  assert.match(s.needsAction!, /does not resolve by itself/);
  assert.equal(s.steps[0].state, "Pending");
});

test("a publish-only stage lists its publication per repository; an unconfigured one is explained", () => {
  const d = detail({ phase: "AwaitingApproval", stage: "ship", round: 31 }, { outbox: [pr({ phase: "Delivered", result: { url: "https://x/pull/1" } })] });
  const s = deriveStageState(d, [], "ship");
  assert.deepEqual(s.steps, []);
  assert.deepEqual(s.publication.map((p) => [p.repository, p.state]), [["controlplane", "not-configured"], ["software-factory", "Delivered"]]);
  assert.match(s.publication[0].detail, /changes stay in the workspace/);
  assert.equal(s.publication[1].url, "https://x/pull/1");
});

test("an active stage reports a running check or a pending delivery before agent work", () => {
  const check = { metadata: { name: "c1" }, spec: { check: "unit-tests", workflow: { stage: "verify", round: 30, purpose: "verification" } },
    status: { phase: "Running", startedAt: "2026-11-17T14:04:15Z" } } as unknown as CheckRun;
  const verifying = deriveStageState(detail({ phase: "Running", stage: "verify", round: 30 }), [check], "verify");
  assert.match(verifying.waitingFor!, /^Check unit-tests \(verification\) running since/);
  assert.equal(verifying.steps[0].state, "not started", "the verifier starts after the checks (ADR-0063)");
  assert.equal(verifying.needsAction, undefined);

  const shipping = deriveStageState(detail({ phase: "Running", stage: "ship", round: 31 },
    { outbox: [pr({ phase: "Pending", attempts: 3, lastError: "HTTP 502", nextAttemptAt: "2026-11-17T14:30:00Z" })] }), [], "ship");
  assert.match(shipping.waitingFor!, /^Pull request delivery for software-factory: Attempt 3, next try .* \(last error: HTTP 502\)/);

  const failed = deriveStageState(detail({ phase: "Running", stage: "ship", round: 31 },
    { outbox: [pr({ phase: "Failed", attempts: 8, lastError: "HTTP 401" })] }), [], "ship");
  assert.match(failed.needsAction!, /could not be delivered/);
  assert.equal(deriveStageState(detail({ phase: "Running", stage: "ship", round: 31 }), [], "verify").status, "done");
});
