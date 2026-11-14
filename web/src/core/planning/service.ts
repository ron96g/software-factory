import { createHash } from "node:crypto";
import type { AgentRun, Approval, Artifact, CheckRun, OutboxMessage, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { AgentQuestionPolicy, ArtifactCheck, CompiledStage, EventRecorder, PlanningCommands, PlanningDecision, PlanningReviewOutcome,
  PlanningDocument, PlanningQueries, PlanningReviewBinding, PlanningRevisionInput, PlanningSections, PlanningWorkspace,
  Principal, Redactor, ResourceReader, ResourceWriter, WorkflowCompiler, WorkItemIntentPolicy } from "../ports/index.ts";
import { isStoreError, StoreError } from "../ports/index.ts";
import { currentPlanningRuns, planningIntent } from "./evidence.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message: string): never => { throw new StoreError(message, "Invalid"); };
const sectionKeys = ["outcome", "scope", "approach", "delivery", "acceptance", "risks"] as const;
const current = (resource: { metadata: { labels?: Record<string, string> } }) =>
  !resource.metadata.labels?.[LABEL_SUPERSEDED] && !resource.metadata.labels?.["factory.ai-dlc.io/replay"];
const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const signature = (decision: PlanningDecision) => hash([
  normalized(decision.question), decision.options.map(normalized).sort(), decision.required,
]);

export function parsePlanningSections(value: unknown): PlanningSections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Plan sections must be an object");
  const text = (key: typeof sectionKeys[number]): string => {
    if (!(key in value)) return invalid(`Plan section ${key} is required`);
    const section: unknown = Reflect.get(value, key);
    if (typeof section !== "string" || !section.trim() || section.length > 12_000) return invalid(`Plan section ${key} must contain 1-12000 characters`);
    return section.trim();
  };
  return { outcome: text("outcome"), scope: text("scope"), approach: text("approach"),
    delivery: text("delivery"), acceptance: text("acceptance"), risks: text("risks") };
}

export function parsePlanningDocument(content: string): PlanningDocument {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return invalid("implementation-plan must contain a JSON object"); }
  const sections = parsePlanningSections(value);
  if (!value || typeof value !== "object" || !("decisions" in value) || !Array.isArray(value.decisions) || value.decisions.length > 100) {
    return invalid("implementation-plan requires decisions[] (at most 100; no questions may be hidden)");
  }
  const decisions: PlanningDecision[] = [];
  for (const raw of value.decisions) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(raw.id) ||
        typeof raw.question !== "string" || !raw.question.trim() || raw.question.length > 2000 ||
        typeof raw.rationale !== "string" || !raw.rationale.trim() || raw.rationale.length > 3000 ||
        typeof raw.required !== "boolean" || !Array.isArray(raw.options) || raw.options.length > 20 ||
        !raw.options.every((option: unknown) => typeof option === "string" && !!option.trim() && option.length <= 1000) ||
        (raw.recommendation !== undefined && (typeof raw.recommendation !== "string" || !raw.recommendation.trim() || raw.recommendation.length > 2000))) {
      return invalid("Each decision needs a stable id, question, options[], rationale and required boolean");
    }
    if (decisions.some((decision) => decision.id === raw.id || normalized(decision.question) === normalized(raw.question))) return invalid("Decision IDs and questions must be unique");
    const options: string[] = raw.options;
    if (new Set(options).size !== options.length) return invalid("Decision options must be unique");
    if (!raw.required && !raw.recommendation) return invalid("Optional decisions need a visible recommended default");
    // Only an optional decision's recommendation is applied as its default; for required decisions it is advice the
    // human reads before answering, so commentary around an option must not invalidate the whole plan.
    if (!raw.required && options.length && !options.includes(raw.recommendation)) {
      return invalid(`Optional decision ${raw.id}: the recommended default must be one of its displayed options`);
    }
    decisions.push({ id: raw.id, question: raw.question.trim(), options, rationale: raw.rationale.trim(),
      required: raw.required, ...(raw.recommendation ? { recommendation: raw.recommendation } : {}) });
  }
  return { ...sections, decisions };
}

/** ADR-0049: a malformed implementation plan goes back to its author immediately, not to a human. */
export const implementationPlanCheck: ArtifactCheck = {
  artifactType: "implementation-plan",
  check: async (_item, artifact) => {
    try { parsePlanningDocument(artifact.spec.content); return undefined; }
    catch (e) { if (!isStoreError(e, "Invalid")) throw e; return e.message; }
  },
};

export class PlanningService implements PlanningQueries, PlanningCommands, PlanningReviewBinding, PlanningReviewOutcome, AgentQuestionPolicy, WorkItemIntentPolicy {
  private readonly d: {
    namespace: string; reader: ResourceReader; writer: ResourceWriter; compiler: WorkflowCompiler;
    events: EventRecorder; redactor: Redactor;
  };
  constructor(d: PlanningService["d"]) { this.d = d; }

  private async item(name: string) {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item) throw new StoreError("Work item not found", "NotFound");
    return item;
  }

  private async workflow(item: WorkItem) {
    if (!item.spec.workflowRef) return undefined;
    const workflow = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    const policy = workflow.planning;
    if (!policy) return undefined;
    const positions = [policy.revisionStage, policy.synthesisStage, policy.reviewStage].map((name) =>
      workflow.stages.findIndex((stage) => stage.name === name));
    if (!workflow.verification || workflow.verification.reviewStage !== policy.reviewStage ||
        positions.some((position, index) => position < 0 || index > 0 && position <= positions[index - 1])) {
      return invalid("Planning needs ordered revision/synthesis/review stages and the existing verified human plan gate");
    }
    return { workflow, policy };
  }

  private async state(item: WorkItem) {
    const options = { namespace: nsOf(item), ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) } };
    const [allArtifacts, allRuns, approvals, checks, outbox] = await Promise.all([
      this.d.reader.list<Artifact>("Artifact", options), this.d.reader.list<AgentRun>("AgentRun", options),
      this.d.reader.list<Approval>("Approval", options), this.d.reader.list<CheckRun>("CheckRun", options),
      this.d.reader.list<OutboxMessage>("OutboxMessage", options),
    ]);
    const owned = (resource: { metadata: Artifact["metadata"] }) => resource.metadata.ownerReferences?.some((owner) =>
      owner.kind === "WorkItem" && owner.uid === item.metadata.uid);
    const runs = currentPlanningRuns(item, allRuns);
    const runNames = new Set(runs.map((run) => run.metadata.name));
    const artifacts = allArtifacts.filter((artifact) => owned(artifact) && current(artifact) &&
      (!artifact.spec.producedBy || runNames.has(artifact.spec.producedBy.agentRunRef.name)));
    const artifact = (type: string) => artifacts.filter((a) => a.spec.artifactTypeRef.name === type).at(-1);
    const active = allRuns.some((run) => owned(run) && (!run.status || ["Pending", "Running"].includes(run.status.phase))) ||
      checks.some((check) => owned(check) && (!check.status || check.status.phase === "Running"));
    const publication = outbox.some((message) => owned(message) && message.spec.action !== "comment");
    const canRevise = !active && !publication && ["AwaitingApproval", "Blocked", "Failed", "Done", "Closed"].includes(item.status?.phase ?? "") &&
      (!item.spec.restart || item.spec.restart.id === item.status?.restartHandled);
    const revision = hash([planningIntent(item), item.status?.stage, item.status?.round,
      artifacts.map((a) => [a.metadata.uid, a.metadata.resourceVersion]), item.spec.restart, item.status?.restartHandled]);
    return { runs, allArtifacts: allArtifacts.filter(owned), artifact, approvals: approvals.filter(owned), canRevise, revision };
  }

  private decisions(item: WorkItem, document: PlanningDocument, runs: AgentRun[], stages: Set<string>) {
    const decisions = [...document.decisions];
    for (const run of runs.filter((run) => stages.has(run.spec.stage))) {
      for (const question of run.status?.result?.questions ?? []) {
        if (decisions.some((decision) => normalized(decision.question) === normalized(question))) continue;
        // A question that explicitly cites a structured decision ("OD-1: …") is that decision, not a new blocker.
        const cited = /^\s*\[?([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\]?\s*[:—–]/.exec(question)?.[1];
        if (cited && document.decisions.some((decision) => decision.id === cited)) continue;
        decisions.push({ id: `question-${hash(normalized(question)).slice(0, 20)}`, question, options: [], required: true,
          rationale: `Unresolved question recorded by ${run.spec.agentRef.name} in ${run.spec.stage}.` });
      }
    }
    return decisions.map((decision) => {
      const saved = item.spec.planning?.answers[decision.id] ??
        Object.values(item.spec.planning?.answers ?? {}).find((answer) => answer.signature === signature(decision));
      return { ...decision, answer: saved?.signature === signature(decision) ? saved.answer : undefined };
    });
  }

  private async evidence(item: WorkItem) {
    const config = await this.workflow(item);
    if (!config) return undefined;
    const state = await this.state(item);
    const { policy, workflow } = config;
    const plan = state.artifact("implementation-plan");
    if (!plan) return invalid("The proposed plan is not available yet. Wait for synthesis or request a revision.");
    const document = parsePlanningDocument(plan.spec.content);
    const spec = state.artifact("spec"), units = state.artifact("units-of-work"), validation = state.artifact("validation-plan");
    const review = state.artifact("review-report");
    const artifacts = [spec, units, validation, plan, review];
    if (artifacts.some((artifact) => !artifact)) return invalid("Specification, Units, validation, implementation plan and independent review are all required");
    const intent = planningIntent(item);
    const producer = (artifact: Artifact) => {
      const run = state.runs.find((r) => r.metadata.name === artifact.spec.producedBy?.agentRunRef.name);
      if (!run || run.status?.phase !== "Succeeded" || !run.status.executor || run.status.executor === "simulated" ||
          !run.status.provenance?.executor || run.status.provenance.executor === "simulated" ||
          run.status.provenance.contexts?.["planning-intent"] !== intent) {
        return invalid("Plan evidence must come from real completed runs using the current context and human revision. Request a fresh revision.");
      }
      return run;
    };
    const s = spec!, u = units!, v = validation!, r = review!;
    producer(s);
    for (const [artifact, inputs] of [[u, [s]], [v, [s, u]], [plan, [s, u, v]], [r, [s, u, v, plan]]] as const) {
      const run = producer(artifact);
      if (inputs.some((input) => run.status?.provenance?.inputs[input.metadata.name] !== input.metadata.resourceVersion)) {
        return invalid("Plan sections or their independent review are stale. Request a fresh revision.");
      }
    }
    if (producer(plan).spec.stage !== policy.synthesisStage || producer(r).spec.stage !== policy.reviewStage ||
        producer(plan).spec.agentRef.name === producer(r).spec.agentRef.name) return invalid("The plan needs an independent review of the synthesized revision");
    const stages = new Set(workflow.stages.slice(0, workflow.stages.findIndex((stage) => stage.name === policy.reviewStage) + 1).map((stage) => stage.name));
    const decisions = this.decisions(item, document, state.runs, stages);
    return { ...state, document, decisions, reviewer: producer(r),
      fingerprint: hash([intent, workflow.versions, artifacts.map((a) => [a!.metadata.uid, a!.metadata.resourceVersion,
        producer(a!).metadata.uid]),
        decisions.map((decision) => [signature(decision), decision.answer ?? (!decision.required ? decision.recommendation : undefined)])]) };
  }

  async binding(item: WorkItem): Promise<string | undefined> {
    return (await this.evidence(item))?.fingerprint;
  }

  async assertReady(item: WorkItem): Promise<void> {
    const evidence = await this.evidence(item);
    if (!evidence) return;
    if (item.spec.planning?.disposition) return invalid("This proposal is rejected or deferred");
    if (item.spec.restart && item.spec.restart.id !== item.status?.restartHandled) return invalid("A planning revision is pending");
    const missing = evidence.decisions.filter((decision) => decision.required && !decision.answer?.trim());
    if (missing.length) return invalid(`Answer ${missing.length} required planning decision(s), then submit answers to update the plan before approval.`);
  }

  async requestsChanges(item: WorkItem): Promise<boolean> {
    const evidence = await this.evidence(item);
    return !!evidence && evidence.reviewer.status?.result?.outcome !== "approve";
  }

  async inspect(_p: Principal, name: string): Promise<PlanningWorkspace> {
    const item = await this.item(name);
    const config = await this.workflow(item);
    if (!config) return { enabled: false, revision: "", decisions: [], unansweredQuestions: [], batchSubmitted: false, ready: false, issues: [], canRevise: false };
    const state = await this.state(item);
    const result: PlanningWorkspace = { enabled: true, revision: state.revision, decisions: [], unansweredQuestions: [],
      batchSubmitted: item.spec.planning?.batchSubmitted ?? false, draft: item.spec.planning?.draft, ready: false, issues: [],
      canRevise: state.canRevise, disposition: item.spec.planning?.disposition };
    const plan = state.artifact("implementation-plan");
    try {
      if (plan) {
        try { result.document = parsePlanningDocument(plan.spec.content); }
        catch (error) {
          if (!isStoreError(error, "Invalid")) throw error;
          throw new StoreError(`The generated plan is malformed (${error.message}). Request a revision, optionally with feedback, to regenerate it; nothing was approved.`, "Invalid");
        }
        const index = config.workflow.stages.findIndex((stage) => stage.name === config.policy.reviewStage);
        result.decisions = this.decisions(item, result.document, state.runs, new Set(config.workflow.stages.slice(0, index + 1).map((stage) => stage.name)));
      }
      await this.assertReady(item);
      result.ready = true;
      result.reviewFindings = await this.requestsChanges(item);
    } catch (error) {
      if (!isStoreError(error, "Invalid") && !isStoreError(error, "Conflict")) throw error;
      result.issues.push(error.message);
    }
    const previous = state.allArtifacts.filter((artifact) => artifact.spec.artifactTypeRef.name === "implementation-plan" &&
      artifact.metadata.uid !== plan?.metadata.uid && !artifact.metadata.labels?.["factory.ai-dlc.io/replay"]).at(-1);
    if (previous) {
      try { result.previous = parsePlanningDocument(previous.spec.content); }
      catch (error) {
        if (!isStoreError(error, "Invalid")) throw error;
        result.historyError = `Previous proposal cannot be compared: ${error.message}`;
      }
    }
    result.unansweredQuestions = result.decisions.filter((decision) => decision.required && !decision.answer).map((decision) => decision.question);
    const approval = state.approvals.find((a) => a.metadata.name === item.status?.blockedBy?.name &&
      item.status.phase === "AwaitingApproval" && a.spec.verification?.kind === "plan" && !a.spec.decision);
    result.approval = approval?.metadata.name;
    return result;
  }

  async revise(p: Principal, name: string, input: PlanningRevisionInput): Promise<WorkItem> {
    if (!input || typeof input !== "object" || !["revise", "decisions", "reopen", "reject", "defer"].includes(input.action) ||
        typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) ||
        typeof input.revision !== "string" || !input.revision || input.revision.length > 100) return invalid("A valid planning action, requestId and displayed revision are required");
    if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 20_000)) return invalid("Context must be text of at most 20000 characters");
    if (input.feedback !== undefined && (typeof input.feedback !== "string" || input.feedback.length > 20_000)) return invalid("Feedback must be text of at most 20000 characters");
    if (input.answers !== undefined && (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers) ||
        Object.entries(input.answers).some(([id, answer]) => !id || typeof answer !== "string" || !answer.trim() || answer.length > 4000))) return invalid("Decision answers must contain nonempty text (at most 4000 characters each)");
    const draft = input.draft === undefined ? undefined : parsePlanningSections(input.draft);
    const requestFingerprint = hash([p.id, input]);
    const item = await this.item(name);
    const config = await this.workflow(item);
    if (!config) return invalid("This workflow does not enable the planning workspace");
    if (item.spec.planning?.request.id === input.requestId) {
      if (item.spec.planning.request.fingerprint !== requestFingerprint) throw new StoreError("Planning requestId was already used with different input", "Conflict");
      await this.d.events.normal(item, "PlanRevisionRequested", `${input.action} by ${p.id}; request ${input.requestId}`);
      return item;
    }
    const workspace = await this.inspect(p, name);
    if (workspace.revision !== input.revision) throw new StoreError("The plan changed. Refresh and compare it before saving; your edits have not been applied.", "Conflict");
    if (!workspace.canRevise) throw new StoreError("Wait for a safe human stop: active agents/checks, a pending revision or publication prevent plan changes.", "Conflict");
    if (input.context !== undefined && input.context.length + (item.spec.originSnapshot?.content.length ?? 0) > 20_000) return invalid("Context plus inherited evidence exceeds 20000 characters");
    if (input.action !== "decisions" && input.answers && Object.keys(input.answers).length) return invalid("Use the decision-sheet action to submit answers");
    if (input.action === "decisions" && (!input.answers || !Object.keys(input.answers).length)) return invalid("Submit at least one decision answer");
    if (input.action === "decisions" && workspace.decisions.some((decision) =>
      decision.required && !decision.answer && !input.answers?.[decision.id]?.trim())) return invalid("Answer every unresolved required decision together before submitting answers");
    const answers = { ...item.spec.planning?.answers };
    for (const [id, answer] of Object.entries(input.answers ?? {})) {
      const decision = workspace.decisions.find((d) => d.id === id);
      if (!decision) return invalid(`Unknown or stale planning decision ${id}`);
      answers[id] = { question: decision.question, signature: signature(decision), answer: this.d.redactor.redact(answer.trim()) };
    }
    const disposition = input.action === "reject" ? "rejected" : input.action === "defer" ? "deferred" : undefined;
    if (draft) for (const key of sectionKeys) draft[key] = this.d.redactor.redact(draft[key]);
    const updated = await this.d.writer.update<WorkItem>({ ...item, spec: { ...item.spec,
      ...(input.context !== undefined ? { context: this.d.redactor.redact(input.context.trim()) || undefined } : {}),
      planning: {
        revision: input.requestId, discovery: input.action === "reopen" ? input.requestId : item.spec.planning?.discovery ?? "initial",
        batchSubmitted: input.action === "reopen" ? false : input.action === "decisions" ? true : item.spec.planning?.batchSubmitted,
        answers, draft: draft ?? item.spec.planning?.draft,
        feedback: input.feedback !== undefined ? this.d.redactor.redact(input.feedback.trim()) : item.spec.planning?.feedback,
        disposition, request: { id: input.requestId, fingerprint: requestFingerprint, by: p.id },
      },
      restart: { id: `plan-${input.requestId}`, stage: config.policy.revisionStage, requestedBy: p.id },
    } });
    await this.d.events.normal(updated, "PlanRevisionRequested", `${input.action} by ${p.id}; request ${input.requestId}. Fresh review required; no approval or publication granted.`);
    return updated;
  }

  async deferQuestions(item: WorkItem, stage: CompiledStage): Promise<boolean> {
    const config = await this.workflow(item);
    if (!config) return false;
    const names = config.workflow.stages.map((s) => s.name);
    return names.indexOf(stage.name) <= names.indexOf(config.policy.reviewStage);
  }

  async intent(item: WorkItem) {
    if (!item.spec.planning?.disposition || !await this.workflow(item)) return undefined;
    return { action: "end" as const, phase: "Closed" as const,
      reason: `Plan ${item.spec.planning.disposition} by ${item.spec.planning.request.by}` };
  }
}
