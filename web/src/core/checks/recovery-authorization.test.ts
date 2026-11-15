import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, AgentRun, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import type { ResourceReader, VerificationContracts, WorkflowCompiler } from "../ports/index.ts";
import { DefaultRecoveryCheckAuthorization } from "../recovery/check-authorization.ts";
import { InMemorySandboxEnvironment } from "../adapters/sandbox/basic.ts";
import { HostEnvironment } from "../adapters/sandbox/host.ts";

test("recovery check authorization binds caller and does not replenish a Unit budget across snapshots or callers", async () => {
  const owner = [{ kind: "WorkItem", name: "item", uid: "item-uid" }];
  const item = { metadata: { name: "item", namespace: "default", uid: "item-uid" },
    spec: { workflowRef: { name: "workflow" } }, status: { phase: "Running", stage: "implement", round: 1 } } as WorkItem;
  const caller = { metadata: { name: "item-implement-0-r1", namespace: "default", uid: "run-uid", ownerReferences: owner,
    labels: { "factory.ai-dlc.io/stage": "implement", "factory.ai-dlc.io/workitem": "item" } },
    spec: { stage: "implement", step: "write", workItemRef: { name: "item" }, agentRef: { name: "developer" },
      assignment: { kind: "unit", unit: "U1", planFingerprint: "plan" } }, status: { phase: "Running" } } as unknown as AgentRun;
  const workspace = { metadata: { name: "ws", namespace: "default", uid: "ws-uid", ownerReferences: owner },
    spec: { repositoryRef: { name: "repo" } } } as Workspace;
  const repository = { metadata: { name: "repo", namespace: "default", uid: "repo-uid", resourceVersion: "1" },
    spec: { verification: { readinessChecks: ["test"] } } } as Repository;
  const agent = { metadata: { name: "developer", namespace: "default" }, spec: { tools: ["run", "write_file"] } } as Agent;
  const origin: CheckWorkflowOrigin = { stage: "implement", round: 1, purpose: "unit-readiness", planFingerprint: "plan",
    attempt: 1, unit: "U1", unitRun: caller.metadata.name, agentRunRef: { name: caller.metadata.name },
    agentRunUid: caller.metadata.uid, agentRequestId: "first" };
  const jobs: CheckRun[] = [];
  const reader = { get: async (kind: string) => ({ WorkItem: item, AgentRun: caller, Workspace: workspace, Agent: agent } as Record<string, unknown>)[kind] ?? null,
    list: async () => jobs } as unknown as ResourceReader;
  const compiler = { compile: async () => ({ recovery: { version: "v1", maxTotalAttempts: 4, humanNeedReserve: 0,
    diagnosticChecks: ["repo/test"] }, verification: { implementationStage: "implement" },
    stage: () => ({ steps: [{ name: "write", agentRef: { name: "developer" } }] }) }) } as unknown as WorkflowCompiler;
  const contracts = { plan: async () => ({ fingerprint: "plan", repositories: [repository], unitPolicy: { maxExecutionAttempts: 1 },
    plan: { units: [{ id: "U1", obligations: [{ checks: ["repo/test"] }] }] } }) } as unknown as VerificationContracts;
  const environment = new InMemorySandboxEnvironment();
  const environments = { select: async () => ({ environment, health: await environment.health(), candidates: [] }), refresh: async () => {} };
  const auth = new DefaultRecoveryCheckAuthorization({ reader, compiler, contracts, environments });
  const input = { item, caller, workspace, repository, origin, check: "test" };
  await auth.authorize(input);
  const existing = { metadata: { name: "job", uid: "job-uid" }, spec: { workItemUid: item.metadata.uid, workspaceUid: workspace.metadata.uid,
    workflow: origin, repositoryRef: { name: "repo" }, check: "test", snapshot: "candidate-1" } } as CheckRun;
  jobs.push(existing);
  await auth.authorize({ ...input, existing });
  await assert.rejects(auth.authorize({ ...input, origin: { ...origin, attempt: 2, agentRequestId: "different" } }), /budget.*exhausted/i);
  await assert.rejects(auth.authorize({ ...input, existing, origin: { ...origin, planFingerprint: "different" } }), /assignment|plan/i);
  caller.spec.replayOf = { name: "older" };
  await assert.rejects(auth.authorize({ ...input, existing }), /active authorized/i);
  caller.spec.replayOf = undefined;
  caller.metadata.name = "item-recovery-e1-d1";
  caller.spec.step = "diagnosis-e1";
  caller.spec.recovery = { episode: "e1", attempt: 1, mode: "diagnosis", unit: "U1", planFingerprint: "plan", policyVersion: "v1",
    trigger: { kind: "AgentRun", name: "failed", uid: "trigger" } };
  item.status!.recovery = [{ id: "e1", workItemUid: "item-uid", planFingerprint: "plan", unit: "U1", policyVersion: "v1", stage: "implement",
    trigger: caller.spec.recovery.trigger, maxTotalAttempts: 4, operatorAllowance: 0, diagnosticAttempts: 1, executionAttempts: 0,
    codeAttempts: 0, disposition: "diagnosing" }];
  workspace.status = { phase: "Ready", baseCommit: "a".repeat(40) };
  const diagnostic: CheckWorkflowOrigin = { ...origin, purpose: "diagnostic", unitRun: undefined, recoveryEpisode: "e1",
    agentRunRef: { name: caller.metadata.name }, agentRequestId: "diagnose" };
  const diagnosticInput = { ...input, caller, origin: diagnostic };
  await auth.authorize(diagnosticInput);
  await assert.rejects(auth.authorize({ ...diagnosticInput, check: "unapproved" }), /outside the authorized episode/i);
  const baseline: CheckWorkflowOrigin = { ...diagnostic, purpose: "baseline", baselineCommit: "a".repeat(40), agentRequestId: "baseline" };
  await auth.authorize({ ...diagnosticInput, origin: baseline });
  await assert.rejects(auth.authorize({ ...diagnosticInput, origin: { ...baseline, baselineCommit: "b".repeat(40) } }), /authorized episode/i);
  const host = new HostEnvironment();
  const unisolated = new DefaultRecoveryCheckAuthorization({ reader, compiler, contracts,
    environments: { select: async () => ({ environment: host, health: { runtime: "host", available: true, isolation: "none" }, candidates: [] }), refresh: async () => {} } });
  await assert.rejects(unisolated.authorize({ ...diagnosticInput, origin: baseline }), /trusted isolated adapter/i);
  const diagnosticJob = { metadata: { name: "diagnostic", uid: "diagnostic-uid" }, spec: { workItemUid: item.metadata.uid,
    workspaceUid: workspace.metadata.uid, workflow: diagnostic, repositoryRef: { name: "repo" }, check: "test" } } as CheckRun;
  const baselineJob = { metadata: { name: "baseline", uid: "baseline-uid" }, spec: { workItemUid: item.metadata.uid,
    workspaceUid: workspace.metadata.uid, workflow: baseline, repositoryRef: { name: "repo" }, check: "test" } } as CheckRun;
  jobs.push(diagnosticJob, baselineJob);
  item.status!.recovery![0].maxTotalAttempts = 3;
  await auth.authorize({ ...diagnosticInput, origin: baseline, existing: baselineJob });
  await assert.rejects(auth.authorize({ ...diagnosticInput, origin: { ...baseline, agentRequestId: "changed" }, existing: baselineJob }), /identity/i);
  await assert.rejects(auth.authorize(diagnosticInput), /budget.*exhausted/i);
});
