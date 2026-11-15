import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { AjvSchemaValidator } from "../core/adapters/schema/ajv.ts";
import { InMemorySandboxEnvironment } from "../core/adapters/sandbox/basic.ts";
import { SandboxCheckRunner } from "../core/adapters/sandbox/check-runner.ts";
import { DefaultRecordedToolTurns } from "../core/agents/recorded-tool-turns.ts";
import { SANDBOX_TOOLS } from "../core/agents/sandbox-tools.ts";
import { ToolLoopExecutor } from "../core/agents/tool-loop.ts";
import { FactoryApp, type FactoryAppDeps } from "../core/app/factory-app.ts";
import { persistedArtifactCheck, RegistryFinishValidator, schemaArtifactCheck } from "../core/artifacts/output-checks.ts";
import type { AgentRun, ArtifactType, CheckRun, Repository, SandboxProfile, WorkItem, Workflow, Workspace } from "../core/model/kinds.ts";
import { ownerRef } from "../core/model/meta.ts";
import type { RecoveryReport } from "../core/model/recovery.ts";
import { API_VERSION } from "../core/model/resource.ts";
import { ANONYMOUS, type AgentTool, type ArtifactCheck, type CompiledWorkflow, type ExecutionContext, type ExecutionEnvironment, type ProposedArtifactCheck, type VerificationContracts } from "../core/ports/index.ts";
import { Registry } from "../core/registry/registry.ts";
import { createCheckRunController } from "../core/checks/controller.ts";
import { WorkflowCheckScheduler } from "../core/checks/scheduler.ts";
import { SerializedWorkspaceJobs } from "../core/checks/workspace-jobs.ts";
import { recoveryFailureSignature, ValidatedRecoveryRouter } from "../core/recovery/router.ts";
import { createAgentRunController } from "../core/runtime/controllers/agentrun.ts";
import { createWorkItemController } from "../core/runtime/controllers/workitem.ts";
import { StoreEventRecorder } from "../core/runtime/event-recorder.ts";
import { SqliteStore } from "../core/store/sqlite-store.ts";
import { DefaultRecorderFactory } from "../core/transcripts/recorder.ts";
import { SqliteTranscriptStore } from "../core/transcripts/sqlite-transcripts.ts";
import { UnitExecutionService } from "../core/units/service.ts";
import { humanApprovalGate } from "../core/workflow/gates.ts";

async function exercise(correct: boolean, maxDiagnosisAttempts = correct ? 2 : 1) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
  const store = new SqliteStore(db, clock);
  const transcripts = new SqliteTranscriptStore(db, clock);
  const events = new StoreEventRecorder(store);
  const redactor = { redact: (text: string) => text };
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
    metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
    status: { phase: "Running", stage: "implement", step: 0, round: 1 } });
  const workspace = await store.create<Workspace>({ apiVersion: API_VERSION, kind: "Workspace",
    metadata: { name: "ws", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "item" },
    status: { phase: "Ready", path: "/fake", baseCommit: "base" } });
  const trigger = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
    metadata: { name: "unit", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, skillRefs: [], stage: "implement", step: "developer",
      inputs: [], outputs: [], assignment: { kind: "unit", planFingerprint: "plan", unit: "U1" } },
    status: { phase: "Succeeded", executor: "tool-loop", result: { outcome: "partial" } } });
  const episode = { id: "ep", workItemUid: item.metadata.uid!, planFingerprint: "plan", unit: "U1", stage: "implement",
    policyVersion: "1", maxTotalAttempts: 5, operatorAllowance: 0, diagnosticAttempts: 1, codeAttempts: 0, executionAttempts: 0,
    disposition: "diagnosing" as const, failureSignature: recoveryFailureSignature(trigger),
    trigger: { kind: "AgentRun" as const, name: "unit", uid: trigger.metadata.uid! } };
  const current = await store.updateStatus({ ...item, status: { ...item.status!, recovery: [episode] } });
  const diagnosis = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
    metadata: { name: "item-recovery-ep-d1", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, skillRefs: [], stage: "implement", step: "diagnosis-ep",
      inputs: [], outputs: [{ name: "recovery-report" }], tools: ["read_file"],
      assignment: { kind: "unit", planFingerprint: "plan", unit: "U1" },
      recovery: { episode: "ep", attempt: 1, mode: "diagnosis", planFingerprint: "plan", unit: "U1", policyVersion: "1", trigger: episode.trigger } } });
  const stages = [{ name: "implement", origin: "flow", lifecyclePhase: "construction", steps: [{ name: "developer", agentRef: { name: "developer" } }] }];
  const workflow: CompiledWorkflow = { name: "flow", stages, stage: (name) => stages.find((s) => s.name === name), next: () => undefined,
    recovery: { version: "1", maxDiagnosisAttempts, maxTotalAttempts: 5, humanNeedReserve: 1, maxOperatorAllowance: 1, diagnosticChecks: [] },
    unitExecution: { barrierStage: "review", maxCodeAttempts: 2, maxExecutionAttempts: 2 } };
  const compiler = { compile: async () => workflow };
  const contracts = { plan: async () => ({ fingerprint: "plan", repositories: [] }) } as unknown as VerificationContracts;
  const definition = parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType;
  const schemas = { get: async () => ({ ...definition.spec.schema!, digest: "schema" }) };
  const validator = new AjvSchemaValidator();
  const router = new ValidatedRecoveryRouter({ reader: store, schemas, validator, contracts });
  const readers = { forWorkspaces: () => ({ readFile: async () => "code", listFiles: async () => [], searchCode: async () => [] }) };
  const proposed = new Registry<ProposedArtifactCheck>();
  const check = schemaArtifactCheck("recovery-report", schemas, validator, router.artifactCheck);
  proposed.register("recovery-report", check);
  const checks = new Registry<ArtifactCheck>();
  checks.register("recovery-report", persistedArtifactCheck(check, { reader: store, readers }));
  const report: RecoveryReport = { schemaVersion: "1", episode: "ep",
    trigger: { ...episode.trigger, resourceVersion: trigger.metadata.resourceVersion! }, failureSignature: episode.failureSignature,
    facts: [], hypotheses: [], actions: [], obligations: ["U1"],
    evidence: [{ kind: "AgentRun", name: trigger.metadata.name, resourceVersion: trigger.metadata.resourceVersion! }], recommendation: "repair" };
  let calls = 0;
  const model = { provider: "test", model: "test", tier: "reasoning", client: {
    complete: async () => "", completeWithTools: async () => {
      calls++;
      return { toolCalls: [{ id: `finish-${calls}`, name: "finish", arguments: { summary: "Diagnosis",
        artifacts: [{ type: "recovery-report", content: correct && calls > 1 ? JSON.stringify(report) : "{}" }] } }] };
    } } };
  const tools = new Registry<AgentTool>();
  for (const tool of SANDBOX_TOOLS) tools.register(tool.name, tool);
  const executor = new ToolLoopExecutor({ reader: store, prompts: { build: () => ({ system: "test", user: "test" }) },
    tools, environments: { select: async () => ({ health: { runtime: "none" } }) } as never, readers,
    turns: new DefaultRecordedToolTurns(), finish: new RegistryFinishValidator({ checks: proposed, readers }) });
  const context = (run: AgentRun) => ({ run, workItem: current,
    agent: { metadata: { name: "developer", namespace: "factory-system" }, spec: { tools: ["read_file"] } }, model,
    repositories: [], workspaces: [workspace], inputs: [], sections: [], clarifications: [], skills: [] }) as unknown as ExecutionContext;
  const agents = createAgentRunController({ reader: store, writer: store, status: store, events, clock,
    contexts: { create: async (run) => context(run) }, executor, recorders: new DefaultRecorderFactory(transcripts, redactor),
    redactor, onError: (message) => { throw new Error(message); } });
  const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler,
    gates: new Registry(), outbox: { enqueue: async () => { throw new Error("not used"); } }, workspaces: { supports: () => false },
    artifactChecks: checks, recovery: router });
  const app = new FactoryApp({ reader: store, writer: store, compiler, events, transcripts } as unknown as FactoryAppDeps);
  try {
    await agents.reconcile(`default/${diagnosis.metadata.name}`);
    for (let i = 0; i < 200; i++) {
      if ((await store.get<AgentRun>("AgentRun", "default", diagnosis.metadata.name))?.status?.phase === "Succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await controller.reconcile("default/item");
    const detail = (await app.getWorkItem(ANONYMOUS, "item"))!;
    const transcript = await app.runTranscript(ANONYMOUS, diagnosis.metadata.name);
    return { detail, transcript, calls, reconcile: async () => {
      await controller.reconcile("default/item");
      return (await app.getWorkItem(ANONYMOUS, "item"))!;
    }, runDiagnosis: async (name: string) => {
      await agents.reconcile(`default/${name}`);
      for (let i = 0; i < 200; i++) {
        if ((await store.get<AgentRun>("AgentRun", "default", name))?.status?.phase === "Succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await controller.reconcile("default/item");
      return (await app.getWorkItem(ANONYMOUS, "item"))!;
    }, close: async () => { await agents.stop(); db.close(); } };
  } catch (error) {
    await agents.stop();
    db.close();
    throw error;
  }
}

test("AC-39-4: malformed diagnosis is corrected in the same recorded tool loop and passes persisted validation", async () => {
  const result = await exercise(true);
  try {
    assert.equal(result.calls, 2);
    assert.equal(result.transcript.filter((m) => m.role === "tool-result" && m.meta?.tool === "finish").length, 1);
    assert.match(result.transcript.find((m) => m.role === "tool-result" && m.meta?.tool === "finish")!.content, /recovery-report/);
    assert.equal(result.detail.workItem.status?.recovery?.[0].disposition, "repairing");
    assert.ok(result.detail.workItem.status?.recovery?.[0].latestReport);
  } finally { await result.close(); }
});

test("AC-39-4: rejected diagnostic output uses the remaining bounded diagnosis before stopping", async () => {
  const result = await exercise(false, 2);
  try {
    assert.equal(result.detail.workItem.status?.phase, "Running");
    assert.equal(result.detail.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
    const pending = await result.reconcile();
    assert.ok(pending.runs.some((run) => run.metadata.name === "item-recovery-ep-d2"));
    const failed = await result.runDiagnosis("item-recovery-ep-d2");
    assert.equal(failed.workItem.status?.phase, "Failed");
    assert.equal(failed.workItem.status?.recovery?.[0].diagnosticAttempts, 2);
    assert.match(failed.workItem.status?.message ?? "", /No valid recovery report/);
  } finally { await result.close(); }
});

test("AC-39-4: exhausted malformed diagnosis retains trigger and fails without an invented report or loop", async () => {
  const result = await exercise(false);
  try {
    assert.equal(result.calls, 3);
    assert.equal(result.detail.workItem.status?.phase, "Failed");
    assert.match(result.detail.workItem.status?.message ?? "", /Invalid recovery report:.*No valid recovery report/s);
    assert.equal(result.detail.workItem.status?.recovery?.[0].trigger.name, "unit");
    assert.equal(result.detail.workItem.status?.recovery?.[0].latestReport, undefined);
    assert.equal(result.transcript.filter((m) => m.role === "tool-result" && m.meta?.tool === "finish").length, 2);
    const again = await result.reconcile();
    assert.equal(again.workItem.status?.phase, "Failed");
    assert.equal(again.runs.length, result.detail.runs.length);
  } finally { await result.close(); }
});

test("AC-39-3/4: recorded malformed diagnosis self-corrects, repairs, runs a named readiness check and reaches the ordinary human gate", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
  const store = new SqliteStore(db, clock);
  const transcripts = new SqliteTranscriptStore(db, clock);
  const events = new StoreEventRecorder(store);
  const redactor = { redact: (text: string) => text };
  const verification = { planningStage: "plan", reviewStage: "plan-review", preflightStage: "preflight", verifyStage: "verify",
    implementationStage: "implement", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 1000 };
  const unitExecution = { barrierStage: "code-review", maxCodeAttempts: 2, maxExecutionAttempts: 2 };
  const recovery = { version: "1", maxDiagnosisAttempts: 2, maxTotalAttempts: 6, humanNeedReserve: 1 as const, maxOperatorAllowance: 1, diagnosticChecks: [] };
  const stages = [
    { name: "implement", origin: "flow", lifecyclePhase: "construction", steps: [{ name: "developer", agentRef: { name: "developer" } }], gate: { type: "unit-progress" } },
    { name: "code-review", origin: "flow", lifecyclePhase: "construction", steps: [], gate: { type: "human-approval" } },
  ];
  const workflow: CompiledWorkflow = { name: "flow", verification, unitExecution, recovery, stages,
    stage: (name) => stages.find((stage) => stage.name === name), next: (name) => stages[stages.findIndex((stage) => stage.name === name) + 1] };
  await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "flow", namespace: "default" },
    spec: { phases: [], verification, unitExecution, recovery } });
  const repository = await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository",
    metadata: { name: "repo", namespace: "default" }, spec: { checks: { test: { command: "named-readiness", resultFormat: "exit-code" } },
      verification: { requiredChecks: ["test"], preflightChecks: [], readinessChecks: ["test"] } } });
  await store.create<SandboxProfile>({ apiVersion: API_VERSION, kind: "SandboxProfile", metadata: { name: "profile", namespace: "default" },
    spec: { image: "", isolation: "container" } });
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
    metadata: { name: "item", namespace: "default" }, spec: { title: "Test", sourceRef: { name: "manual" }, workflowRef: { name: "flow" } },
    status: { phase: "Running", stage: "implement", step: 0, round: 1 } });
  const workspace = await store.create<Workspace>({ apiVersion: API_VERSION, kind: "Workspace",
    metadata: { name: "ws", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "item" },
    status: { phase: "Ready", path: "/fake", baseCommit: "base" } });
  const unit = { id: "U1", title: "Deliver", dependsOn: [], criteria: ["AC-1"],
    obligations: [{ id: "O1", description: "Deliver", checks: ["repo/test"] }] };
  const contract = { fingerprint: "plan", policy: verification, unitPolicy: unitExecution,
    plan: { units: [unit], criteria: [], checks: ["repo/test"], preflight: [] }, repositories: [repository] };
  const contracts = { plan: async () => contract } as unknown as VerificationContracts;
  const compiler = { compile: async () => workflow };
  const candidate: Record<string, string> = { "code.ts": "before" };
  const memory = new InMemorySandboxEnvironment({ seed: candidate,
    handlers: [(command, files) => command.includes("named-readiness")
      ? { exitCode: files.get("code.ts") === "fixed" ? 0 : 1, stdout: files.get("code.ts") === "fixed" ? "passed" : "not fixed", termination: { kind: "exit" } }
      : undefined] });
  const environment: ExecutionEnvironment = {
    runtime: memory.runtime, health: () => memory.health(),
    prepare: async (spec) => {
      const sandbox = await memory.prepare(spec);
      return {
        id: sandbox.id, exec: sandbox.exec.bind(sandbox), readFile: sandbox.readFile.bind(sandbox),
        listFiles: sandbox.listFiles.bind(sandbox), diff: sandbox.diff.bind(sandbox), dispose: sandbox.dispose.bind(sandbox),
        writeFile: async (path, content) => { await sandbox.writeFile(path, content); candidate[path] = content; },
      };
    },
  };
  const health = await memory.health();
  const environments = { select: async () => ({ environment, health, candidates: [health] }), refresh: async () => {} };
  const snapshots = { fingerprint: async () => "tree" };
  const jobs = new SerializedWorkspaceJobs(store);
  const scheduler = new WorkflowCheckScheduler({ reader: store, writer: store, snapshots, environments, redactor, jobs });
  const checkController = createCheckRunController({ reader: store, status: store, logs: transcripts, runner: new SandboxCheckRunner(store, environments),
    snapshots, clock, events, redactor, contracts, onError: (message) => { throw new Error(message); } });
  const readers = { forWorkspaces: () => ({
    readFile: async (path: string) => {
      if (candidate[path] === undefined) throw new Error(`Missing evidence file: ${path}`);
      return candidate[path];
    }, listFiles: async () => Object.keys(candidate), searchCode: async () => [],
  }) };
  const candidates = { candidate: async () => ({ workspaces: [workspace], snapshots: { ws: "tree" }, profiles: { repo: "default" },
    health, fingerprint: "tree" }) };
  const units = new UnitExecutionService({ namespace: "default", reader: store, compiler, contracts, scheduler, events, clock, redactor, candidates, readers });
  const schema = (parse(readFileSync(new URL("../../../artifacts/recovery-report.yaml", import.meta.url), "utf8")) as ArtifactType).spec.schema!;
  const schemas = { get: async () => ({ ...schema, digest: "schema" }) };
  const schemaValidator = new AjvSchemaValidator();
  const router = new ValidatedRecoveryRouter({ reader: store, schemas, validator: schemaValidator, contracts });
  const proposed = new Registry<ProposedArtifactCheck>();
  const reportCheck = schemaArtifactCheck("recovery-report", schemas, schemaValidator, router.artifactCheck);
  proposed.register("recovery-report", reportCheck);
  const artifactChecks = new Registry<ArtifactCheck>();
  artifactChecks.register("recovery-report", persistedArtifactCheck(reportCheck, { reader: store, readers }));
  const tools = new Registry<AgentTool>();
  for (const tool of SANDBOX_TOOLS) tools.register(tool.name, tool);
  const executor = new ToolLoopExecutor({ reader: store, prompts: { build: () => ({ system: "test", user: "test" }) }, tools,
    environments, readers, jobs, turns: new DefaultRecordedToolTurns(), finish: new RegistryFinishValidator({ checks: proposed, readers }) });
  const modelFor = (run: AgentRun) => {
    let turns = 0;
    return { provider: "test", model: "test", tier: "reasoning", client: {
      complete: async () => "", completeWithTools: async () => {
        turns++;
        if (run.spec.recovery?.mode === "diagnosis") {
          const current = (await store.get<WorkItem>("WorkItem", "default", "item"))!;
          const episode = current.status!.recovery!.find((e) => e.id === run.spec.recovery!.episode)!;
          const trigger = (await store.get<AgentRun>("AgentRun", "default", episode.trigger.name))!;
          const report: RecoveryReport = { schemaVersion: "1", episode: episode.id,
            trigger: { ...episode.trigger, resourceVersion: trigger.metadata.resourceVersion! }, failureSignature: recoveryFailureSignature(trigger),
            facts: ["Unit incomplete"], hypotheses: [], actions: [], obligations: ["O1"],
            evidence: [{ kind: "AgentRun", name: trigger.metadata.name, resourceVersion: trigger.metadata.resourceVersion! }], recommendation: "repair" };
          return { toolCalls: [{ id: `d${turns}`, name: "finish", arguments: { summary: "Diagnosed",
            artifacts: [{ type: "recovery-report", content: turns === 1 ? "{}" : JSON.stringify(report) }] } }] };
        }
        if (run.spec.recovery?.mode === "repair") {
          if (turns === 1) return { toolCalls: [{ id: "write", name: "write_file", arguments: { path: "code.ts", content: "fixed" } }] };
          return { toolCalls: [{ id: "finish", name: "finish", arguments: { summary: "Repaired", outcome: "complete",
            artifacts: [{ type: "unit-result", content: JSON.stringify({ unit: "U1", outcome: "complete",
              obligations: [{ id: "O1", status: "done", evidence: [{ path: "code.ts" }] }] }) }] } }] };
        }
        return { toolCalls: [{ id: "finish", name: "finish", arguments: { summary: "Incomplete", outcome: "partial" } }] };
      } } };
  };
  const agents = createAgentRunController({ reader: store, writer: store, status: store, events, clock, executor,
    contexts: { create: async (run) => ({ run, workItem: (await store.get<WorkItem>("WorkItem", "default", "item"))!,
      agent: { metadata: { name: "developer", namespace: "default" }, spec: { tools: ["read_file", "write_file"], sandboxRef: { name: "profile" } } },
      model: modelFor(run), repositories: [repository], workspaces: [workspace], inputs: [], sections: [], clarifications: [], skills: [],
      sandbox: health }) as unknown as ExecutionContext },
    recorders: new DefaultRecorderFactory(transcripts, redactor), redactor, onError: (message) => { throw new Error(message); } });
  const gates = new Registry();
  gates.register("unit-progress", units.gate);
  gates.register("human-approval", humanApprovalGate);
  const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates: gates as never,
    outbox: { enqueue: async () => { throw new Error("not used"); } }, workspaces: { supports: () => false },
    assignments: units, runFailures: units, artifactChecks, recovery: router });
  const app = new FactoryApp({ reader: store, writer: store, compiler, events, transcripts } as unknown as FactoryAppDeps);
  try {
    const before = await environment.prepare({ profile: (await store.get<SandboxProfile>("SandboxProfile", "default", "profile"))!, repositories: [repository], workspaces: [workspace] });
    assert.equal((await before.exec("named-readiness")).exitCode, 1, "readiness must fail without the actual repair");
    await before.dispose();
    for (let i = 0; i < 300; i++) {
      await controller.reconcile("default/item");
      for (const run of await store.list<AgentRun>("AgentRun", { namespace: "default" })) {
        if (!run.status || run.status.phase === "Pending") await agents.reconcile(`default/${run.metadata.name}`);
      }
      for (const check of await store.list<CheckRun>("CheckRun", { namespace: "default" })) {
        if (!check.status || check.status.phase === "Running") await checkController.reconcile(`default/${check.metadata.name}`);
      }
      const state = (await app.getWorkItem(ANONYMOUS, "item"))!;
      if (state.workItem.status?.phase === "AwaitingApproval" || state.workItem.status?.phase === "Failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const detail = (await app.getWorkItem(ANONYMOUS, "item"))!;
    assert.equal(detail.workItem.status?.phase, "AwaitingApproval", detail.workItem.status?.message ?? "");
    assert.equal(detail.workItem.status?.stage, "code-review");
    assert.equal(detail.approvals.length, 1);
    assert.equal(detail.approvals[0].spec.decision, undefined);
    assert.equal(detail.clarifications.length, 0);
    const diagnosis = detail.runs.find((run) => run.spec.recovery?.mode === "diagnosis")!;
    const transcript = await app.runTranscript(ANONYMOUS, diagnosis.metadata.name);
    assert.match(transcript.find((entry) => entry.role === "tool-result" && entry.meta?.tool === "finish")?.content ?? "", /recovery-report/);
    assert.equal(diagnosis.status?.provenance?.toolUse?.finishCorrections, 1);
    assert.ok(detail.runs.some((run) => run.spec.recovery?.mode === "repair" && run.status?.phase === "Succeeded"));
    const checks = await store.list<CheckRun>("CheckRun", { namespace: "default" });
    assert.ok(checks.some((check) => check.spec.check === "test" && check.spec.workflow?.purpose === "unit-readiness" && check.status?.outcome === "Passed"));
    assert.equal(candidate["code.ts"], "fixed");
    assert.ok(memory.sandboxes.some((sandbox) => sandbox.log.some((command) => command.includes("named-readiness"))));
  } finally { await agents.stop(); await checkController.stop(); db.close(); }
});
