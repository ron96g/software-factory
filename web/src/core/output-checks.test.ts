import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Artifact, WorkItem, Workflow } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { type ArtifactCheck, type ExecutionContext, type GateEvaluator } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { Registry } from "./registry/registry.ts";
import { outputFeedbackContext } from "./agents/output-feedback.ts";

test("malformed output reruns only its step with the reason, then fails without advancing after the bounded budget", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-14T12:00:00Z") };
  const store = new SqliteStore(db, clock);
  try {
    await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "wf", namespace: "factory-system" },
      spec: { phases: [{ name: "inception", stages: [{ name: "plan", steps: [
        { name: "draft", agentRef: { name: "po" } }, { name: "synthesize", agentRef: { name: "architect" }, outputs: [{ artifactRef: { name: "implementation-plan" } }] },
      ] }, { name: "next" }] }] } });
    const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
      spec: { title: "t", sourceRef: { name: "manual" }, workflowRef: { name: "wf" } }, status: { phase: "Running", stage: "plan", step: 1, round: 1 } });
    const checks = new Registry<ArtifactCheck>();
    checks.register("implementation-plan", { artifactType: "implementation-plan",
      check: async (_item, artifact) => artifact.spec.content === "ok" ? undefined : "recommendation must be one of the options" });
    const events = new StoreEventRecorder(store);
    const controller = createWorkItemController({ reader: store, writer: store, status: store, events, clock,
      compiler: new DefaultWorkflowCompiler(store), gates: new Registry<GateEvaluator>(), workspaces: { supports: () => false },
      outbox: { enqueue: async () => { throw new Error("no outbox"); } }, artifactChecks: checks });
    const current = async () => (await store.get<WorkItem>("WorkItem", "default", "item"))!;
    async function produce(content: string) {
      await controller.reconcile(keyOf(item));
      const wi = await current();
      const name = `item-plan-1-r${wi.status!.round}`;
      const run = (await store.get<AgentRun>("AgentRun", "default", name))!;
      await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: `${name}-plan`, namespace: "default", ownerReferences: [ownerRef(item)] },
        spec: { artifactTypeRef: { name: "implementation-plan" }, workItemRef: { name: "item" }, producedBy: { agentRunRef: { name }, agentRef: { name: "architect" } }, format: "json", content } });
      await store.updateStatus<AgentRun>({ ...run, status: { phase: "Succeeded", executor: "tool-loop", outputs: [{ name: `${name}-plan` }] } });
      await controller.reconcile(keyOf(item));
      return current();
    }
    let wi = await produce("bad");
    assert.deepEqual([wi.status?.step, wi.status?.round, wi.status?.retries?.["output:plan/synthesize"]], [1, 2, 1], "only the step reruns");
    assert.ok(!(await store.get("AgentRun", "default", "item-plan-0-r2")), "earlier steps are not repeated");

    const feedback = outputFeedbackContext({ reader: store, redactor: { redact: (t) => t } });
    const sections = await feedback.provide({ workItem: wi, run: { spec: { stage: "plan", step: "synthesize" } } } as ExecutionContext);
    assert.match(sections[0]?.content ?? "", /recommendation must be one of the options/);

    wi = await produce("bad");
    wi = await produce("bad");
    assert.equal(wi.status?.step, 1, "invalid output never advances");
    assert.equal(wi.status?.phase, "Failed");
    assert.match(wi.status?.message ?? "", /Invalid output.*recommendation/);
    wi = await current();
    await store.updateStatus({ ...wi, status: { ...wi.status!, phase: "Running", step: 1, round: 9, retries: {} } });
    wi = await produce("ok");
    assert.equal(wi.status?.step, 2, "well-formed output proceeds immediately");
  } finally { db.close(); }
});
