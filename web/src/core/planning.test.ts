import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Approval, Artifact, CheckRun, OutboxMessage, Repository, WorkItem, Workflow } from "./model/kinds.ts";
import type { PlanningDocument } from "./model/planning.ts";
import { LABEL_SUPERSEDED } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { ANONYMOUS as p, type GateEvaluator, type PlanningRevisionInput } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { PlanningService, parsePlanningDocument } from "./planning/service.ts";
import { planningIntent } from "./planning/evidence.ts";
import { planningReview } from "./planning/review.ts";
import { VerificationService } from "./verification/service.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { Registry } from "./registry/registry.ts";
import { readFileSync } from "node:fs";
import { persistedArtifactCheck } from "./artifacts/output-checks.ts";
import { parse as parseYaml } from "yaml";
import type { ArtifactType } from "./model/kinds.ts";
import { DefinitionArtifactSchemas } from "./artifacts/schemas.ts";
import { AjvSchemaValidator } from "./adapters/schema/ajv.ts";
import { StoreDraftFeedbackBatch } from "./app/feedback-batch.ts";
import type { InlineFeedback } from "./model/kinds.ts";

const document: PlanningDocument = {
  outcome: "Customers can export their own records.", scope: "Include CSV. Exclude bulk tenant exports.",
  approach: "Reuse the existing export service (repo:src/export.ts:10).", delivery: "Unit 1: endpoint. Unit 2: UI after Unit 1.",
  acceptance: "AC-1: export only authorized records. Check repo/test; human checks the downloaded file.",
  risks: "Tenant isolation; validate authorization server-side.",
  decisions: [],
};
const required = { id: "sensitive-data", question: "Include personal data?", options: ["Exclude", "Include"],
  recommendation: "Exclude", rationale: "Changes the privacy boundary.", required: true };

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-14T13:00:00Z") };
  const store = new SqliteStore(db, clock);
  const compiler = new DefaultWorkflowCompiler(store);
  const events = new StoreEventRecorder(store);
  const redactor = { redact: (text: string) => text.replaceAll("secret-value", "[REDACTED]") };
  const schemas = new DefinitionArtifactSchemas(store);
  const planning = new PlanningService({ namespace: "default", reader: store, writer: store, compiler, events, redactor,
    schemas, schemaValidator: new AjvSchemaValidator(), notes: new StoreDraftFeedbackBatch({ namespace: "default", reader: store, writer: store }) });
  const workflow = await store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "planned", namespace: "factory-system" },
    spec: { planning: { revisionStage: "spec", synthesisStage: "implementation-plan", reviewStage: "spec-review" },
      verification: { planningStage: "validation-plan", reviewStage: "spec-review", preflightStage: "preflight",
        implementationStage: "implement", verifyStage: "verify", maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 1000 },
      phases: [{ name: "inception", stages: [
        { name: "triage", steps: [{ name: "triage", agentRef: { name: "triager" } }] },
        { name: "spec", steps: [{ name: "write", agentRef: { name: "product-owner" } }] },
        { name: "validation-plan" }, { name: "implementation-plan" },
        { name: "spec-review", gate: { type: "verification-plan-review" } },
      ] }, { name: "construction", stages: [
        { name: "preflight", gate: { type: "verified-checks" } },
        { name: "implement", steps: [{ name: "write", agentRef: { name: "developer" } }] },
        { name: "code-review", gate: { type: "verification-candidate-review" } },
        { name: "verify", gate: { type: "verified-checks" } },
      ] }] } });
  await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
    spec: { checks: { test: "tests", preflight: "prepare" }, verification: { requiredChecks: ["test"], preflightChecks: ["preflight"] } } });
  await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
    spec: { title: "Export", sourceRef: { name: "manual" }, workflowRef: { name: "planned" }, repositoryRefs: [{ name: "repo" }] },
    status: { phase: "AwaitingApproval", stage: "spec-review", round: 5 } });
  const item = async () => (await store.get<WorkItem>("WorkItem", "default", "item"))!;
  const verification = new VerificationService({ namespace: "default", reader: store, writer: store, compiler,
    snapshots: { fingerprint: async () => "tree" }, scheduler: { submit: async () => { throw new Error("checks must not run while planning"); } },
    environments: { select: async () => { throw new Error("planning must not execute a sandbox"); }, refresh: async () => {} },
    planning, planReview: planning, events, clock, redactor });
  const gates = new Registry<GateEvaluator>();
  for (const gate of verification.gates) gates.register(gate.type, gate.type === "verification-plan-review" ? planningReview(gate, compiler) : gate);
  const controller = createWorkItemController({ reader: store, writer: store, status: store, compiler, events, clock, gates,
    workspaces: { supports: () => false }, outbox: { enqueue: async () => { throw new Error("planning must never publish"); } },
    questionPolicy: planning, intentPolicy: planning, stagePolicy: verification });
  let generation = 0;
  async function seed(plan: PlanningDocument = document) {
    generation++;
    const wi = await item();
    const artifacts: Artifact[] = [];
    for (const [type, stage, author, inputs, content] of [
      ["spec", "spec", "product-owner", [], "AC-1: export only authorized records"],
      ["units-of-work", "spec", "architect", [0], "units: [endpoint, ui]"],
      ["validation-plan", "validation-plan", "architect", [0, 1], JSON.stringify({ criteria: [{ id: "AC-1", description: "Authorized export", checks: ["repo/test"] }], checks: ["repo/test"], preflight: ["repo/preflight"] })],
      ["implementation-plan", "implementation-plan", "architect", [0, 1, 2], JSON.stringify(plan)],
      ["review-report", "spec-review", "reviewer", [0, 1, 2, 3], "Coherent proposal; human decisions remain explicit."],
    ] as const) {
      const name = `${type}-${generation}`;
      const run = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
        metadata: { name: `run-${name}`, namespace: "default", ownerReferences: [ownerRef(wi)] },
        spec: { workItemRef: { name: "item" }, agentRef: { name: author }, stage, step: type, skillRefs: [],
          inputs: inputs.map((index) => ({ name: artifacts[index].spec.artifactTypeRef.name })), outputs: [{ name: type }] },
        status: { phase: "Succeeded", executor: "llm", result: { outcome: type === "review-report" ? "approve" : undefined },
          provenance: { executor: "llm", definitions: {}, inputs: Object.fromEntries(inputs.map((index) =>
            [artifacts[index].metadata.name, artifacts[index].metadata.resourceVersion!])), contexts: { "planning-intent": planningIntent(wi) } } } });
      artifacts.push(await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact",
        metadata: { name, namespace: "default", ownerReferences: [ownerRef(wi)] },
        spec: { workItemRef: { name: "item" }, artifactTypeRef: { name: type }, content, format: "json",
          producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: { name: author } } } }));
    }
    return artifacts;
  }
  async function seedSingleRun(plan: PlanningDocument = document) {
    const artifacts = await seed(plan);
    const wi = await item();
    const freshWorkflow = (await store.get<Workflow>("Workflow", "factory-system", "planned"))!;
    const inception = freshWorkflow.spec.phases.find((phase) => phase.name === "inception")!;
    const stages = inception.stages.filter((stage) => !["spec", "validation-plan", "implementation-plan"].includes(stage.name));
    const reviewIndex = stages.findIndex((stage) => stage.name === "spec-review");
    stages.splice(reviewIndex, 0, { name: "plan", steps: [{ name: "produce-plan", agentRef: { name: "planner" },
      outputs: ["spec", "units-of-work", "validation-plan", "implementation-plan"].map((name) => ({ artifactRef: { name } })) }] });
    await store.update({ ...freshWorkflow, spec: { ...freshWorkflow.spec,
      planning: { plannerStage: "plan", reviewStage: "spec-review" },
      verification: { ...freshWorkflow.spec.verification!, planningStage: "plan" },
      phases: freshWorkflow.spec.phases.map((phase) => phase.name === "inception" ? { ...phase, stages } : phase),
    } });
    const planner = await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: `planner-${generation}`, namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "planner" }, stage: "plan", step: "produce-plan",
        inputs: [], outputs: ["spec", "units-of-work", "validation-plan", "implementation-plan"].map((name) => ({ name })), skillRefs: [] },
      status: { phase: "Succeeded", executor: "llm", provenance: { executor: "llm", definitions: {}, inputs: {},
        contexts: { "planning-intent": planningIntent(wi) } } } });
    const planningArtifacts = artifacts.slice(0, 4);
    const updatedArtifacts: Artifact[] = [];
    for (const artifact of planningArtifacts) updatedArtifacts.push(await store.update({ ...artifact, spec: { ...artifact.spec,
      producedBy: { agentRunRef: { name: planner.metadata.name }, agentRef: { name: "planner" } },
    } }));
    const review = updatedArtifacts.length > 0 ? artifacts[4] : undefined;
    const reviewRun = await store.get<AgentRun>("AgentRun", "default", review!.spec.producedBy!.agentRunRef.name);
    await store.updateStatus({ ...reviewRun!, status: { ...reviewRun!.status!,
      provenance: { ...reviewRun!.status!.provenance!,
        inputs: Object.fromEntries(updatedArtifacts.map((artifact) => [artifact.metadata.name, artifact.metadata.resourceVersion!])),
      },
    } });
    return updatedArtifacts;
  }
  async function openReview() {
    const wi = await item();
    const compiled = await compiler.compile(wi.spec.workflowRef!, "default");
    const stage = compiled.stage("spec-review")!;
    const decision = await gates.get("verification-plan-review")!.evaluate({ workItem: wi, stage, gate: stage.gate! });
    assert.equal(decision.action, "await-approval");
    if (decision.action !== "await-approval") throw new Error(JSON.stringify(decision));
    const approval = await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval",
      metadata: { name: `approval-${generation}`, namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, stage: "spec-review", approvers: [], verification: decision.verification } });
    const fresh = await item();
    await store.updateStatus({ ...fresh, status: { ...fresh.status!, phase: "AwaitingApproval", stage: "spec-review",
      blockedBy: { kind: "Approval", name: approval.metadata.name }, restartHandled: fresh.spec.restart?.id } });
    return approval;
  }
  async function revise(action: PlanningRevisionInput["action"], requestId: string, extra: Partial<PlanningRevisionInput> = {}) {
    return planning.revise(p, "item", { action, requestId, revision: (await planning.inspect(p, "item")).revision, ...extra });
  }
  async function regenerate(plan = document) {
    await controller.reconcile(keyOf(await item()));
    await seed(plan);
    return openReview();
  }
  return { db, store, compiler, planning, verification, workflow, item, controller, seed, seedSingleRun, openReview, revise, regenerate, clock, redactor, schemas };
}

test("typed review approval pins the schema contract; legacy reports remain readable but cannot stand in for the new contract", async () => {
  const f = await fixture();
  try {
    await f.seedSingleRun();
    assert.equal((await f.planning.inspect(p, "item")).ready, true, "legacy workflows retain their original contract");
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "planned"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec, phases: workflow.spec.phases.map((phase) => ({
      ...phase, stages: phase.stages.map((stage) => stage.name === "spec-review" ? { ...stage, steps: [{
        name: "typed-review", agentRef: { name: "reviewer" }, outputs: [{ artifactRef: { name: "planning-review" } }],
      }] } : stage),
    })) } });
    const historical = (await f.store.list<Artifact>("Artifact")).find((artifact) => artifact.spec.artifactTypeRef.name === "review-report")!;
    let workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, false);
    assert.match(workspace.issues.join(" "), /historical Markdown reports remain readable/);
    assert.equal((await f.store.get<Artifact>("Artifact", "default", historical.metadata.name))?.spec.content, historical.spec.content);

    const definition = parseYaml(readFileSync(new URL("../../../artifacts/planning-review.yaml", import.meta.url), "utf8")) as ArtifactType;
    await f.store.create({ ...definition, metadata: { ...definition.metadata, namespace: "factory-system" } });
    const schema = (await f.schemas.get("planning-review", "default"))!;
    const review = await f.store.update<Artifact>({ ...historical, spec: { ...historical.spec,
      artifactTypeRef: { name: "planning-review" }, format: "json",
      content: JSON.stringify({ schemaVersion: "2", summary: "Reviewed the current proposal.", decisions: [], findings: [] }),
    } });
    const run = (await f.store.get<AgentRun>("AgentRun", "default", review.spec.producedBy!.agentRunRef.name))!;
    await f.store.update<AgentRun>({ ...run, spec: { ...run.spec, outputs: [{ name: "planning-review" }] } });
    const fresh = (await f.store.get<AgentRun>("AgentRun", "default", run.metadata.name))!;
    await f.store.updateStatus<AgentRun>({ ...fresh, status: { ...fresh.status!, provenance: { ...fresh.status!.provenance!,
      contexts: { ...fresh.status!.provenance!.contexts, "artifact-schema:planning-review": schema.digest },
    } } });
    const persisted = persistedArtifactCheck(f.planning.reviewCheck, { reader: f.store, readers: { forWorkspaces: () => assert.fail("no workspaces pinned") } });
    assert.equal(await persisted.check(await f.item(), review), undefined);
    const approval = await f.openReview();
    workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.readiness, "ready");

    await f.verification.validate(approval, "approve");

    const stored = (await f.store.get<ArtifactType>("ArtifactType", "factory-system", "planning-review"))!;
    await f.store.update({ ...stored, spec: { ...stored.spec, schema: { ...stored.spec.schema!,
      jsonSchema: { ...stored.spec.schema!.jsonSchema, $comment: "Revised contract; a fresh review must consume it." },
    } } });
    workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, false);
    assert.equal(workspace.readiness, "needs-agent-repair");
    assert.match(workspace.issues.join(" "), /schema changed/);
    await assert.rejects(f.verification.validate(approval, "approve", "Accept despite all concerns"), /schema changed/);
    // ADR-0057: an earlier schema version stays readable but can no longer back an approval.
    const v1 = { schemaVersion: "1", summary: "Earlier review.", decisions: [], findings: [
      { id: "F1", kind: "advisory", summary: "Old evidence shape.", evidence: [{ name: "spec", resourceVersion: "1" }] }] };
    const current = (await f.store.get<Artifact>("Artifact", "default", review.metadata.name))!;
    await f.store.update<Artifact>({ ...current, spec: { ...current.spec, content: JSON.stringify(v1) } });
    workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.readiness, "needs-agent-repair");
    assert.equal(workspace.review?.summary, "Earlier review.");
    assert.match(workspace.issues.join(" "), /schema version 1; the current version is 2/);
  } finally { f.db.close(); }
});

test("legacy planning can migrate explicitly and supersedes old-workflow evidence", async () => {
  const f = await fixture();
  try {
    const artifacts = await f.seed();
    await f.openReview();
    const source = structuredClone(f.workflow.spec);
    const inception = source.phases.find((phase) => phase.name === "inception")!;
    const stages = inception.stages.filter((stage) => !["spec", "validation-plan", "implementation-plan"].includes(stage.name));
    const reviewIndex = stages.findIndex((stage) => stage.name === "spec-review");
    stages.splice(reviewIndex, 0, { name: "plan", steps: [{ name: "produce-plan", agentRef: { name: "planner" },
      outputs: ["spec", "units-of-work", "validation-plan", "implementation-plan"].map((name) => ({ artifactRef: { name } })) }] });
    await f.store.create<Workflow>({ apiVersion: API_VERSION, kind: "Workflow",
      metadata: { name: "factory-plan", namespace: "factory-system" },
      spec: { ...source, planning: { plannerStage: "plan", reviewStage: "spec-review" },
        verification: { ...source.verification!, planningStage: "plan" },
        phases: source.phases.map((phase) => phase.name === "inception" ? { ...phase, stages } : phase),
      } });

    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.canMigrate, true);
    const input: PlanningRevisionInput = { action: "migrate", requestId: "move-to-one-planner",
      revision: workspace.revision, workflow: "factory-plan" };
    const migrated = await f.planning.revise(p, "item", input);
    assert.equal(migrated.spec.workflowRef?.name, "factory-plan");
    assert.equal(migrated.spec.restart?.stage, "plan");
    assert.deepEqual(migrated.spec.restart?.supersedeFrom, { workflow: "planned", stage: "spec" });
    assert.equal((await f.planning.revise(p, "item", input)).spec.restart?.id, migrated.spec.restart?.id);

    await f.controller.reconcile(keyOf(migrated));
    assert.equal((await f.item()).status?.stage, "plan");
    for (const artifact of artifacts) {
      assert.ok((await f.store.get<Artifact>("Artifact", "default", artifact.metadata.name))?.metadata.labels?.[LABEL_SUPERSEDED]);
    }
  } finally { f.db.close(); }
});

test("plan edits preserve originals, invalidate approval and regenerate requirements with idempotent optimistic requests", async () => {
  const f = await fixture();
  try {
    const original = await f.seed();
    const approval = await f.openReview();
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    await f.verification.validate(approval, "approve");
    const input: PlanningRevisionInput = { action: "revise", requestId: "edit-1",
      revision: (await f.planning.inspect(p, "item")).revision, context: "Keep private fields out. secret-value",
      draft: { ...document, scope: "CSV only; never export private fields." }, feedback: "Preserve the privacy constraint." };
    const saved = await f.planning.revise(p, "item", input);
    assert.equal(saved.spec.restart?.stage, "spec");
    assert.match(saved.spec.context!, /\[REDACTED\]/);
    assert.equal(saved.spec.planning?.draft?.scope, input.draft?.scope);
    const retried = await f.planning.revise(p, "item", input);
    assert.equal(retried.spec.restart?.id, saved.spec.restart?.id);
    await assert.rejects(f.planning.revise(p, "item", { ...input, feedback: "different" }), /different input/);
    await assert.rejects(f.verification.validate(approval, "approve"), /current context|revision/);
    await assert.rejects(f.planning.revise(p, "item", { ...input, requestId: "stale" }), /plan changed/);
    assert.equal((await f.store.get<Artifact>("Artifact", "default", original[3].metadata.name))?.spec.content, JSON.stringify(document));
    const revised = { ...document, scope: input.draft!.scope };
    const next = await f.regenerate(revised);
    assert.ok((await f.store.get<Artifact>("Artifact", "default", original[3].metadata.name))?.metadata.labels?.[LABEL_SUPERSEDED]);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.document?.scope, revised.scope);
    assert.equal(workspace.previous?.scope, document.scope);
    assert.equal(next.spec.decision, undefined, "saving and regeneration never approve");
    await f.verification.validate(next, "approve");
    await assert.rejects(f.verification.validate(approval, "approve"), /stale/);
  } finally { f.db.close(); }
});

test("one-run planning requires all four artifacts from the same real planner and exact independent review", async () => {
  const f = await fixture();
  try {
    const bundle = await f.seedSingleRun();
    const approval = await f.openReview();
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    assert.equal((await f.verification.plan(await f.item(), false)).artifact.metadata.uid, bundle[2].metadata.uid,
      "validation accepts a plan produced alongside its specification in one planner run");
    await f.verification.validate(approval, "approve");

    const wi = await f.item();
    const second = await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "planner-second", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "planner" }, stage: "plan", step: "second",
        inputs: [], outputs: [{ name: "units-of-work" }], skillRefs: [] },
      status: { phase: "Succeeded", executor: "llm", provenance: { executor: "llm", definitions: {}, inputs: {},
        contexts: { "planning-intent": planningIntent(wi) } } } });
    const units = bundle[1];
    await f.store.update({ ...units, spec: { ...units.spec,
      producedBy: { agentRunRef: { name: second.metadata.name }, agentRef: { name: "planner" } },
    } });
    await assert.rejects(f.planning.binding(await f.item()), /one current planner run/);
    await assert.rejects(f.verification.validate(approval, "approve"), /one current planner run/);
  } finally { f.db.close(); }
});

test("decision-sheet workflows accept only risks and decisions and expose the planner's source artifacts", async () => {
  const sheet: PlanningDocument = { risks: "Assumption: hits are shown in one place.", decisions: [] };
  const useDecisionSheet = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const workflow = (await f.store.get<Workflow>("Workflow", "factory-system", "planned"))!;
    await f.store.update({ ...workflow, spec: { ...workflow.spec, planning: { plannerStage: "plan", reviewStage: "spec-review", planFormat: "decision-sheet" } } });
  };
  const f = await fixture();
  try {
    const bundle = await f.seedSingleRun(sheet);
    await useDecisionSheet(f);
    const approval = await f.openReview();
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, true, workspace.issues.join("; "));
    assert.equal(workspace.format, "decision-sheet");
    assert.deepEqual(workspace.sources.map((source) => [source.type, source.artifact]),
      bundle.slice(0, 3).map((artifact) => [artifact.spec.artifactTypeRef.name, artifact.metadata.name]));
    assert.equal(workspace.document?.outcome, undefined);
    await f.verification.validate(approval, "approve");

    const plan = bundle[3];
    const proposed = async (content: string) => f.planning.artifactCheck.check({ item: await f.item(), type: "implementation-plan", content, files: null,
      producer: { runName: "", stage: "", inputs: {}, contexts: {}, questions: [], repositories: [] } });
    assert.equal(await proposed(plan.spec.content), undefined);
    assert.match(await proposed(JSON.stringify(document)) ?? "",
      /only risks and decisions; remove outcome, scope, approach, delivery, acceptance/);
    await assert.rejects(f.revise("revise", "full-draft", { draft: { ...document } }), /only risks and decisions/);
    const revised = await f.revise("revise", "risks-draft", { draft: { risks: "Hits may be cached." } });
    assert.deepEqual(revised.spec.planning?.draft, { risks: "Hits may be cached." });
  } finally { f.db.close(); }

  const legacy = await fixture();
  try {
    await legacy.seedSingleRun();
    await useDecisionSheet(legacy);
    const workspace = await legacy.planning.inspect(p, "item");
    assert.equal(workspace.ready, false);
    assert.match(workspace.issues.join("\n"), /does not match this workflow's decision-sheet format/);
    assert.ok(workspace.document?.outcome, "an existing six-section plan remains readable");
  } finally { legacy.db.close(); }
});

test("full-format workflows still require all six plan sections; either complete shape parses without a format", () => {
  assert.throws(() => parsePlanningDocument(JSON.stringify({ risks: "r", decisions: [] }), "full"), /Plan section outcome is required/);
  assert.throws(() => parsePlanningDocument(JSON.stringify({ outcome: "o", risks: "r", decisions: [] })), /Plan section scope is required/);
  assert.deepEqual(parsePlanningDocument(JSON.stringify({ risks: "r", decisions: [] })), { risks: "r", decisions: [] });
});

test("submitted answers remain directly editable and changed decision semantics require fresh answers, not reopening", async () => {
  const f = await fixture();
  try {
    const plan = { ...document, decisions: [required] };
    await f.seed(plan);
    const approval = await f.openReview();
    assert.equal((await f.planning.inspect(p, "item")).ready, false);
    await assert.rejects(f.verification.validate(approval, "approve"), /required planning decision/);
    await assert.rejects(f.revise("decisions", "empty", { answers: {} }), /at least one/);
    await f.revise("decisions", "answers-1", { answers: { "sensitive-data": "Exclude" } });
    assert.equal((await f.item()).spec.planning?.batchSubmitted, true);
    const next = await f.regenerate({ ...plan, decisions: [{ ...required, options: ["Include", "Exclude"] }] });
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    await f.verification.validate(next, "approve");
    await f.revise("decisions", "answers-2", { answers: { "sensitive-data": "Include" } });
    await assert.rejects(f.verification.validate(next, "approve"), /current context|revision|stale/);
    const corrected = await f.regenerate(plan);
    assert.equal((await f.planning.inspect(p, "item")).decisions[0].answer, "Include");
    await f.verification.validate(corrected, "approve");
    await f.revise("revise", "new-scope", { feedback: "Reconsider tenant scope." });
    const changed = { ...document, decisions: [{ ...required, question: "Include all tenants' personal data?" }] };
    const newApproval = await f.regenerate(changed);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.batchSubmitted, true);
    assert.equal(workspace.decisions[0].answer, undefined, "changed question cannot reuse an old answer");
    assert.equal(workspace.ready, false);
    assert.match(workspace.issues.join(" "), /Answer 1 required planning decision/);
    assert.doesNotMatch(workspace.issues.join(" "), /reopen/i);
    await assert.rejects(f.verification.validate(newApproval, "approve"), /required planning decision/);
    await f.revise("decisions", "answers-3", { answers: { "sensitive-data": "Exclude" } });
    const fresh = await f.regenerate(changed);
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
    assert.equal(fresh.spec.decision, undefined, "answering never approves the regenerated proposal");
    await f.verification.validate(fresh, "approve");
    assert.equal((await f.store.list("Clarification")).length, 0, "decision submission never starts a clarification interview");
  } finally { f.db.close(); }
});

test("withdrawing a planning answer removes it from intent and keeps bounded auditable history", async () => {
  const f = await fixture();
  try {
    const plan = { ...document, decisions: [required] };
    await f.seed(plan);
    await f.openReview();
    await f.revise("decisions", "answer-before-withdrawal", { answers: { "sensitive-data": "Exclude" } });
    await f.regenerate(plan);
    const answered = await f.item();
    assert.ok(answered.spec.planning?.answers["sensitive-data"].answeredAt);
    // ADR-0072: a second record of the same question (e.g. under an agent's question ID) is withdrawn with it.
    const planning = answered.spec.planning!;
    await f.store.update<WorkItem>({ ...answered, spec: { ...answered.spec, planning: { ...planning,
      answers: { ...planning.answers, "question-copy": { ...planning.answers["sensitive-data"], signature: "other" } } } } });
    const before = await f.planning.inspect(p, "item");
    const withdrawn = await f.planning.revise(p, "item", { action: "decisions", requestId: "withdraw-answer",
      revision: before.revision, withdraw: ["sensitive-data"] });
    assert.equal(withdrawn.spec.planning?.answers["sensitive-data"], undefined);
    assert.equal(withdrawn.spec.planning?.answers["question-copy"], undefined);
    assert.equal(withdrawn.spec.planning?.withdrawn?.length, 1);
    assert.deepEqual(withdrawn.spec.planning?.withdrawn?.[0], {
      decisionId: "sensitive-data", question: required.question, answer: "Exclude", withdrawnBy: p.id,
      at: withdrawn.spec.planning?.withdrawn?.[0].at,
    });
    assert.ok(!Number.isNaN(Date.parse(withdrawn.spec.planning!.withdrawn![0].at)));
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.recordedAnswers.length, 0);
    assert.equal(workspace.withdrawnAnswers[0].answer, "Exclude");
    assert.equal(workspace.withdrawnAnswers[0].question, required.question);
    assert.equal(workspace.decisions[0].answer, undefined);
    assert.equal(workspace.ready, false);
    const retry = await f.planning.revise(p, "item", { action: "decisions", requestId: "withdraw-answer",
      revision: before.revision, withdraw: ["sensitive-data"] });
    assert.equal(retry.spec.planning?.withdrawn?.length, 1, "idempotent retries do not duplicate withdrawal history");
  } finally { f.db.close(); }
});

test("new required decisions accept a direct consolidated submission while preserving previous answers and retry safety", async () => {
  const f = await fixture();
  try {
    const plan = { ...document, decisions: [required] };
    await f.seed(plan);
    await f.openReview();
    await f.revise("decisions", "initial-answers", { answers: { "sensitive-data": "Exclude" } });
    const additional = { ...required, id: "export-access", question: "Who can request an export?",
      options: ["Tenant admins", "All tenant users"], recommendation: "Tenant admins", rationale: "Defines the access policy." };
    const revised = { ...plan, decisions: [required, additional] };
    const approval = await f.regenerate(revised);
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.batchSubmitted, true);
    assert.equal(workspace.canRevise, true);
    assert.equal(workspace.ready, false);
    assert.equal(workspace.decisions[0].answer, "Exclude");
    assert.equal(workspace.decisions[1].answer, undefined);
    const input: PlanningRevisionInput = { action: "decisions", requestId: "additional-answers",
      revision: workspace.revision, answers: { "export-access": "Tenant admins" } };
    const saved = await f.planning.revise(p, "item", input);
    const retried = await f.planning.revise(p, "item", input);
    assert.equal(retried.spec.restart?.id, saved.spec.restart?.id);
    assert.equal(saved.spec.planning?.answers["sensitive-data"].answer, "Exclude");
    await assert.rejects(f.planning.revise(p, "item", { ...input, answers: { "export-access": "All tenant users" } }), /different input/);
    await assert.rejects(f.verification.validate(approval, "approve"), /current context|revision|stale/);
    const fresh = await f.regenerate(revised);
    const ready = await f.planning.inspect(p, "item");
    assert.deepEqual(ready.decisions.map((decision) => decision.answer), ["Exclude", "Tenant admins"]);
    assert.equal(ready.ready, true);
    assert.equal(fresh.spec.decision, undefined);
    await f.verification.validate(fresh, "approve");
    assert.equal((await f.store.list("Clarification")).length, 0);
  } finally { f.db.close(); }
});

test("questions from different agents form one sheet and partial submissions cannot omit required answers", async () => {
  const f = await fixture();
  try {
    await f.seed({ ...document, decisions: [required] });
    const wi = await f.item();
    await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "triage-question", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "triager" }, stage: "triage", step: "triage", inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Succeeded", result: { questions: ["Which customers may export?"] } } });
    await f.openReview();
    const sheet = await f.planning.inspect(p, "item");
    assert.equal(sheet.decisions.length, 2);
    await assert.rejects(f.revise("decisions", "partial", { answers: { "sensitive-data": "Exclude" } }), /every unresolved required decision/);
    assert.equal((await f.item()).spec.planning, undefined);
    await f.revise("decisions", "all-answers", { answers: Object.fromEntries(sheet.decisions.map((decision) => [decision.id, "Only authorized tenant users; exclude private fields"])) });
    await f.regenerate({ ...document, decisions: [required] });
    assert.equal((await f.planning.inspect(p, "item")).ready, true);
  } finally { f.db.close(); }
});

test("planning questions are deferred; malformed review stops durably without Clarification or re-asking", async () => {
  const f = await fixture();
  try {
    const wi = await f.item();
    const workflow = await f.compiler.compile(wi.spec.workflowRef!, "default");
    assert.equal(await f.planning.deferQuestions(wi, workflow.stage("spec")!), true);
    assert.equal(await f.planning.deferQuestions(wi, workflow.stage("implement")!), false);
    await f.store.updateStatus({ ...wi, status: { phase: "Running", stage: "triage", round: 1, step: 0 } });
    await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
      metadata: { name: "item-triage-0-r1", namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, agentRef: { name: "triager" }, stage: "triage", step: "triage", inputs: [], outputs: [], skillRefs: [] },
      status: { phase: "Succeeded", result: { questions: ["Which customers?"] } } });
    await f.controller.reconcile(keyOf(wi));
    assert.equal((await f.item()).status?.step, 1);
    const fresh = await f.item();
    await f.store.updateStatus({ ...fresh, status: { phase: "Running", stage: "spec-review", round: 2 } });
    await f.controller.reconcile(keyOf(wi));
    await f.controller.reconcile(keyOf(wi));
    const stopped = await f.item();
    assert.equal(stopped.status?.phase, "Blocked");
    assert.equal(stopped.status?.blockedBy, undefined);
    assert.equal(stopped.status?.conditions?.find((condition) => condition.type === "Blocked")?.reason, "HumanAttentionRequired");
    assert.match(stopped.status?.message ?? "", /validation-plan/);
    assert.equal((await f.store.list("Clarification")).length, 0);
    assert.equal((await f.planning.inspect(p, "item")).canRevise, true);
  } finally { f.db.close(); }
});

test("real exact-input and independent review provenance is required, including after context edits", async (t) => {
  for (const variant of ["simulated", "stale-context", "stale-input", "same-reviewer", "replay"] as const) {
    await t.test(variant, async () => {
      const f = await fixture();
      try {
        await f.seed();
        const approval = await f.openReview();
        const run = (await f.store.get<AgentRun>("AgentRun", "default", variant === "same-reviewer" ? "run-review-report-1" : "run-implementation-plan-1"))!;
        if (variant === "same-reviewer") await f.store.update({ ...run, spec: { ...run.spec, agentRef: { name: "architect" } } });
        else if (variant === "replay") await f.store.update({ ...run, spec: { ...run.spec, replayOf: { name: "old-run" } } });
        else if (variant === "stale-context") {
          const item = await f.item();
          await f.store.update({ ...item, spec: { ...item.spec, context: "Changed after review" } });
        } else await f.store.updateStatus({ ...run, status: { ...run.status!,
          ...(variant === "simulated" ? { executor: "simulated" } : {}),
          ...(variant === "stale-input" ? { provenance: { ...run.status!.provenance!, inputs: {} } } : {}),
        } });
        await assert.rejects(f.verification.validate(approval, "approve"), /current|stale|independent|not available|unresolved/);
        assert.equal((await f.planning.inspect(p, "item")).ready, false);
      } finally { f.db.close(); }
    });
  }
});

test("unresolved AI plan review findings never veto the human: approving needs an explicit reason", async () => {
  const f = await fixture();
  try {
    await f.seed();
    const approval = await f.openReview();
    const review = (await f.store.get<AgentRun>("AgentRun", "default", "run-review-report-1"))!;
    await f.store.updateStatus({ ...review, status: { ...review.status!, result: { outcome: "changes-requested" } } });
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, true);
    assert.equal(workspace.reviewFindings, true);
    await assert.rejects(f.verification.validate(approval, "approve"), /AI plan review still requests changes/);
    await f.verification.validate(approval, "approve", "Accepting: findings are about unread files, which U2 reads first");
  } finally { f.db.close(); }
});

test("revision boundaries exclude active jobs/publication and explicit disposition is applied only by the controller", async (t) => {
  for (const variant of ["agent", "check", "publication"] as const) {
    await t.test(variant, async () => {
      const f = await fixture();
      try {
        await f.seed(); await f.openReview();
        const wi = await f.item();
        const metadata = { name: "active", namespace: "default", ownerReferences: [ownerRef(wi)] };
        if (variant === "agent") await f.store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata,
          spec: { workItemRef: { name: "item" }, agentRef: { name: "developer" }, stage: "implement", step: "write", inputs: [], outputs: [], skillRefs: [] } });
        if (variant === "check") await f.store.create<CheckRun>({ apiVersion: API_VERSION, kind: "CheckRun", metadata,
          spec: { workItemRef: { name: "item" }, workItemUid: wi.metadata.uid!, workspaceRef: { name: "ws" }, workspaceUid: "ws",
            repositoryRef: { name: "repo" }, repositoryVersion: "1", check: "test", command: "tests", timeoutMs: 1000,
            snapshot: "tree", environment: { runtime: "fake", profileVersion: "1" }, requestedBy: "human", requestFingerprint: "1" } });
        if (variant === "publication") await f.store.create<OutboxMessage>({ apiVersion: API_VERSION, kind: "OutboxMessage", metadata, spec: { action: "open-pull-request", payload: {} } });
        assert.equal((await f.planning.inspect(p, "item")).canRevise, false);
        await assert.rejects(f.revise("revise", "unsafe"), /safe human stop/);
      } finally { f.db.close(); }
    });
  }
  for (const action of ["defer", "reject"] as const) {
    const f = await fixture();
    try {
      await f.seed(); await f.openReview();
      const updated = await f.revise(action, `human-${action}`);
      assert.equal(updated.status?.phase, "AwaitingApproval", "command cannot write controller status");
      await f.controller.reconcile(keyOf(updated));
      assert.equal((await f.item()).status?.phase, "Closed");
      assert.equal((await f.planning.inspect(p, "item")).disposition, action === "defer" ? "deferred" : "rejected");
      assert.equal((await f.store.list("OutboxMessage")).length, 0);
    } finally { f.db.close(); }
  }
});

test("legacy workflows retain their verified contract and ordinary question behavior", async () => {
  const f = await fixture();
  try {
    const workflow = await f.store.get<Workflow>("Workflow", "factory-system", "planned");
    await f.store.update({ ...workflow!, spec: { ...workflow!.spec, planning: undefined } });
    await f.seed();
    const wi = await f.item();
    assert.equal((await f.planning.inspect(p, "item")).enabled, false);
    assert.equal(await f.planning.binding(wi), undefined);
    await f.planning.assertReady(wi);
    assert.equal(await f.planning.deferQuestions(wi, (await f.compiler.compile(wi.spec.workflowRef!, "default")).stage("spec")!), false);
    await assert.rejects(f.planning.revise(p, "item", { action: "revise", requestId: "legacy", revision: "displayed" }), /does not enable/);
    const contract = await f.verification.plan(wi, false);
    assert.ok(contract.fingerprint);
  } finally { f.db.close(); }
});

test("a malformed historical proposal is reported without making a fresh valid plan unapprovable", async () => {
  const f = await fixture();
  try {
    const old = await f.seed();
    await f.store.update({ ...old[3], spec: { ...old[3].spec, content: "incomplete old output" } });
    await f.seed();
    const approval = await f.openReview();
    const workspace = await f.planning.inspect(p, "item");
    assert.equal(workspace.ready, true);
    assert.match(workspace.historyError ?? "", /Previous proposal cannot be compared/);
    await f.verification.validate(approval, "approve");
  } finally { f.db.close(); }
});

test("a required decision's advisory recommendation may add commentary; an optional default must be an exact option", () => {
  const sections = { outcome: "o", scope: "s", approach: "a", delivery: "d", acceptance: "c", risks: "r" };
  const decision = { id: "OD-1", question: "Reject deletions of referenced definitions?", options: ["(a) Reject", "(b) Accept"],
    recommendation: "(a) Reject. This matches the existing remove() behaviour.", rationale: "Safety", required: true };
  const parsed = parsePlanningDocument(JSON.stringify({ ...sections, decisions: [decision] }));
  assert.equal(parsed.decisions[0].recommendation, decision.recommendation);
  assert.throws(() => parsePlanningDocument(JSON.stringify({ ...sections, decisions: [{ ...decision, required: false }] })),
    /recommended default must be one of its displayed options/);
});

test("upstream questions citing an existing decision ID fold into that decision instead of adding blockers", async () => {
  const document = parsePlanningDocument(JSON.stringify({ outcome: "o", scope: "s", approach: "a", delivery: "d", acceptance: "c", risks: "r",
    decisions: [{ id: "OD-1", question: "Reject deletions of referenced definitions?", options: ["Reject", "Accept"], rationale: "Safety", required: true }] }));
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const run = { spec: { stage: "spec", agentRef: { name: "product-owner" } },
    status: { result: { questions: ["OD-1: should deletion be rejected (a) or accepted (b)?", "OD-9: an unknown decision?", "Which namespace owns it?"] } } } as AgentRun;
  const decisions = (service as unknown as { decisions(item: WorkItem, d: typeof document, runs: AgentRun[], stages: Set<string>): { id: string }[] })
    .decisions({ spec: {} } as WorkItem, document, [run], new Set(["spec"]));
  assert.deepEqual(decisions.map((d) => d.id.startsWith("question-") ? "question" : d.id), ["OD-1", "question", "question"]);
});

test("AC-3 decisions keep answersQuestionIds and reject malformed links", () => {
  const d = { id: "d1", question: "q", options: [], rationale: "r", required: false, recommendation: "x", answersQuestionIds: ["q-abc"] };
  const doc = parsePlanningDocument(JSON.stringify({ risks: "r", decisions: [d] }));
  assert.deepEqual(doc.decisions[0].answersQuestionIds, ["q-abc"]);
  assert.throws(() => parsePlanningDocument(JSON.stringify({ risks: "r", decisions: [{ ...d, answersQuestionIds: [1] }] })), /Each decision needs/);
});

test("AC-3 a decision citing an upstream question id suppresses it regardless of wording, and answered state", () => {
  const document = parsePlanningDocument(JSON.stringify({ risks: "r",
    decisions: [{ id: "D1", question: "Completely different wording?", options: ["A", "B"], rationale: "r", required: true, answersQuestionIds: ["q-up-1"] }] }));
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const run = { spec: { stage: "triage", agentRef: { name: "triager" } },
    status: { result: { questions: [{ id: "q-up-1", text: "Which scope?" }, { id: "q-up-2", text: "Another thing?" }] } } } as AgentRun;
  const call = (item: WorkItem) => (service as unknown as { decisions(i: WorkItem, d: typeof document, r: AgentRun[], s: Set<string>): { id: string; answer?: string }[] })
    .decisions(item, document, [run], new Set(["triage"]));
  assert.deepEqual(call({ spec: {} } as WorkItem).map((d) => d.id.startsWith("question-") ? "question" : d.id), ["D1", "question"]);
  const answered = { spec: { planning: { answers: { D1: { question: "x", signature: "s", answer: "A" } } } } } as unknown as WorkItem;
  assert.deepEqual(call(answered).map((d) => d.id.startsWith("question-") ? "question" : d.id), ["D1", "question"]);
});

test("ADR-0072 an agent's recorded question keeps the answer the human gave to the same question under another ID", () => {
  const document = parsePlanningDocument(JSON.stringify({ risks: "r",
    decisions: [{ id: "crd-owner", question: "Who installs the CRDs?", options: ["Operator", "Factory"], rationale: "r", required: true }] }));
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const run = { spec: { stage: "plan", agentRef: { name: "planner" } },
    status: { result: { questions: ["Do runtime objects also move to the cluster, or only definitions?"] } } } as AgentRun;
  const item = { spec: { planning: { answers: {
    scope: { question: "Do runtime objects also move to the cluster,  or only definitions?", signature: "with-options", answer: "Definitions only" },
    other: { question: "Who installs the CRDs?", signature: "old-options", answer: "Operator" },
  } } } } as unknown as WorkItem;
  const decisions = (service as unknown as { decisions(i: WorkItem, d: typeof document, r: AgentRun[], s: Set<string>): { id: string; answer?: string }[] })
    .decisions(item, document, [run], new Set(["plan"]));
  assert.equal(decisions.find((d) => d.id.startsWith("question-"))?.answer, "Definitions only");
  assert.equal(decisions.find((d) => d.id === "crd-owner")?.answer, undefined, "a decision with options still needs a matching signature");
});

test("ADR-0087 the same question recorded by several agents is one decision that keeps the options it offered", () => {
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const researcher = { spec: { stage: "triage", step: "0", agentRef: { name: "code-researcher" } },
    status: { result: { questions: [{ id: "Q1", text: "Which database?", blocker: true, options: ["Postgres", "SQLite"] },
      { id: "Q2", text: "Which region?" }] } } } as AgentRun;
  const triager = { spec: { stage: "triage", step: "1", agentRef: { name: "triager" } },
    status: { result: { questions: [{ id: "Q1", text: "Which database should the service use?", options: ["Postgres", "SQLite"] }] } } } as AgentRun;
  const decisions = (service as unknown as { decisions(i: WorkItem, d: PlanningDocument, r: AgentRun[], s: Set<string>): { id: string; question: string; options: string[] }[] })
    .decisions({ spec: {} } as WorkItem, { risks: "r", decisions: [] }, [researcher, triager], new Set(["triage"]));
  const questions = decisions.filter((d) => d.id.startsWith("question-"));
  assert.equal(questions.length, 2, "one decision per question id; a distinct id stays separate");
  assert.equal(questions[0].question, "Which database?");
  assert.deepEqual(questions[0].options, ["Postgres", "SQLite"], "the recorded options survive to the sheet");
  assert.deepEqual(questions[1].options, [], "a question that offered none stays option-less");
});

test("ADR-0087 a recorded question's answer still binds by its text now that it shows options", () => {
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const run = { spec: { stage: "triage", agentRef: { name: "triager" } },
    status: { result: { questions: [{ id: "Q1", text: "Which database?", blocker: true, options: ["Postgres", "SQLite"] }] } } } as AgentRun;
  const item = { spec: { planning: { answers: {
    old: { question: "Which database?", signature: "answered-when-option-less", answer: "SQLite" },
  } } } } as unknown as WorkItem;
  const decisions = (service as unknown as { decisions(i: WorkItem, d: PlanningDocument, r: AgentRun[], s: Set<string>): { id: string; answer?: string }[] })
    .decisions(item, { risks: "r", decisions: [] }, [run], new Set(["triage"]));
  assert.equal(decisions.find((d) => d.id.startsWith("question-"))?.answer, "SQLite");
});

test("ADR-0087 a same-id copy is suppressed once the first recording folds into a decision", () => {
  const service = new PlanningService({ namespace: "default", reader: undefined!, writer: undefined!, compiler: undefined!,
    events: undefined!, redactor: { redact: (t) => t } });
  const document = parsePlanningDocument(JSON.stringify({ risks: "r",
    decisions: [{ id: "D1", question: "Which database?", options: ["Postgres", "SQLite"], rationale: "r", required: true }] }));
  const researcher = { spec: { stage: "triage", step: "0", agentRef: { name: "code-researcher" } },
    status: { result: { questions: [{ id: "Q1", text: "Which database?" }] } } } as AgentRun;
  const triager = { spec: { stage: "triage", step: "1", agentRef: { name: "triager" } },
    status: { result: { questions: [{ id: "Q1", text: "Which database should the service use?" }] } } } as AgentRun;
  const decisions = (service as unknown as { decisions(i: WorkItem, d: PlanningDocument, r: AgentRun[], s: Set<string>): { id: string }[] })
    .decisions({ spec: {} } as WorkItem, document, [researcher, triager], new Set(["triage"]));
  assert.deepEqual(decisions.map((d) => d.id), ["D1"], "the folded question and its reworded same-id copy add no decision");
});

test("ADR-0073 a planning revision takes the draft inline notes on re-run stages into the same batch", async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.openReview();
    const wi = await f.item();
    const note = (name: string, stage: string) => f.store.create<InlineFeedback>({ apiVersion: API_VERSION, kind: "InlineFeedback",
      metadata: { name, namespace: "default", ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: "item" }, targetRef: { name: "a" }, producedBy: { agentRunRef: { name: "r" }, agentRef: { name: "x" }, stage, step: "s" },
        quote: "q", comment: "c", author: p.id } });
    await note("on-spec", "spec");
    await note("on-triage", "triage");
    await f.revise("revise", "with-notes", { feedback: "Tighten scope." });
    const get = async (name: string) => (await f.store.get<InlineFeedback>("InlineFeedback", "default", name))!;
    assert.equal((await get("on-spec")).spec.submitted?.id, "plan-with-notes");
    assert.equal((await get("on-triage")).spec.submitted, undefined, "triage is not re-run by a planning revision");
  } finally { f.db.close(); }
});
