import { createHash } from "node:crypto";
import type { Agent, AgentRun, Approval, Artifact, CheckRun, CheckWorkflowOrigin, Repository, SandboxProfile, WorkItem, Workspace } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { resolveRef } from "../refs/refs.ts";
import { SandboxUnavailableError, StoreError, isStoreError, type AgentBaselineRequests, type AgentCheckLogReader, type AgentCheckRequests, type AgentToolOffering, type ApprovalGateEvaluator, type CheckRunScheduler,
  type Clock, type CompiledStage, type CompiledWorkflow, type EventRecorder, type ExecutionContext, type ExecutionEnvironmentSelector, type GateContext,
  type GateDecision, type GateEvaluator, type Principal, type Redactor, type ResourceReader, type ResourceWriter,
  type ValidationContract, type ValidationPlan, type VerificationActions, type VerificationApprovalGuard,
  type RecoveryCheckAuthorization, type StageEntryPolicy, type StageResumptionPolicy, type PlanReconfirmation, type PublicationRecovery, type ProposedArtifactCheck, type TranscriptReader, type VerificationContracts, type VerificationPublicationGuard, type WorkflowCompiler, type WorkspaceSnapshotter } from "../ports/index.ts";
import type { PlanningReviewBinding, PlanningReviewOutcome } from "../ports/planning.ts";
import type { CandidateCompleteness, CandidateSnapshots, CandidateState } from "../ports/units.ts";
import { parseUnitManifest, unitChecks } from "../model/units.ts";
import { isScoped, scopeSatisfies } from "../model/check-scope.ts";
import { gapId, verificationPolicyGaps, type PolicyGap } from "../model/verification-policy.ts";

/** Required plan checks without a configured command: they can only ever be Waived, so the plan reviewer must know. */
const planGaps = (contract: Pick<ValidationContract, "plan" | "repositories">): PolicyGap[] =>
  contract.repositories.flatMap(verificationPolicyGaps).filter((gap) => gap.role === "required" && contract.plan.checks.includes(gapId(gap)));
export function gapCriterion(gaps: PolicyGap[]): string[] {
  const waivable = gaps.filter((g) => g.waivable).map(gapId), blocking = gaps.filter((g) => !g.waivable).map(gapId);
  return [
    ...(waivable.length ? [`Known evidence gaps: ${waivable.join(", ")} have no configured command. They stay NotVerified and need an explicit waiver at verification unless an operator configures them first.`] : []),
    ...(blocking.length ? [`Unpassable checks: ${blocking.join(", ")} have no configured command and are not waivable, so verification will stop. An operator must configure them before this work can complete.`] : []),
  ];
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message: string): never => { throw new StoreError(message, "Invalid"); };
const active = (run: CheckRun) => !run.status || run.status.phase === "Running";
const owned = (wi: WorkItem) => ({ namespace: nsOf(wi), ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) } });
const eligible = (r: { metadata: { labels?: Record<string, string> } }) =>
  !r.metadata.labels?.[LABEL_SUPERSEDED] && !r.metadata.labels?.["factory.ai-dlc.io/replay"];
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string" && !!v.trim());
/** ADR-0054: the original plan binding an approved re-confirmation of `fingerprint` carries forward. */
const reconfirmed = (approvals: Approval[], item: WorkItem, fingerprint: string, reviewStage: string) => {
  const latest = approvals.filter((a) => a.spec.verification?.kind === "plan" && a.spec.verification.rebinds &&
    a.spec.verification.fingerprint === fingerprint && a.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid)).at(-1);
  const original = latest?.spec.verification?.rebinds;
  return latest?.spec.decision === "approve" && !!latest.spec.decidedBy && original &&
    approvedBinding(approvals, item, "plan", original, reviewStage) ? original : undefined;
};
const approvedBinding = (approvals: Approval[], item: WorkItem, kind: NonNullable<Approval["spec"]["verification"]>["kind"], fingerprint: string, stage?: string) => {
  const latest = approvals.filter((a) => (!stage || a.spec.stage === stage) && a.spec.verification?.kind === kind &&
    a.spec.verification.fingerprint === fingerprint && a.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid)).at(-1);
  return latest?.spec.decision === "approve" && !!latest.spec.decidedBy &&
    (kind !== "waiver" || (latest.spec.comment?.trim().length ?? 0) >= 10);
};

function verificationPolicy(workflow: CompiledWorkflow) {
  const policy = workflow.verification;
  if (!policy) return invalid("workflow has no verified contract");
  const names = [policy.planningStage, policy.reviewStage, policy.preflightStage, policy.implementationStage, policy.verifyStage];
  const positions = names.map((name) => workflow.stages.findIndex((stage) => stage.name === name));
  if (positions.some((position, index) => position < 0 || (index > 0 && position <= positions[index - 1]))) {
    return invalid("verification stages must exist in planning, review, preflight, implementation, verification order");
  }
  if (workflow.stage(policy.reviewStage)?.gate?.type !== "verification-plan-review" ||
      workflow.stage(policy.preflightStage)?.gate?.type !== "verified-checks" ||
      workflow.stage(policy.verifyStage)?.gate?.type !== "verified-checks" ||
      !workflow.stages.slice(positions[3] + 1, positions[4]).some((stage) => stage.gate?.type === "verification-candidate-review")) {
    return invalid("verification policy requires bound plan/candidate review gates and durable preflight/verification gates");
  }
  if (policy.preparationStage && (workflow.stage(policy.preparationStage)?.gate?.type !== "verification-candidate-review" ||
      workflow.stages.findIndex((stage) => stage.name === policy.preparationStage) <= positions[3] ||
      workflow.stages.findIndex((stage) => stage.name === policy.preparationStage) >= positions[4])) {
    return invalid("candidate preparation must run on entry to candidate review, after implementation and before verification");
  }
  if (!Number.isSafeInteger(policy.maxCodeAttempts) || policy.maxCodeAttempts < 0 || policy.maxCodeAttempts > 10 ||
      !Number.isSafeInteger(policy.maxExecutionAttempts) || policy.maxExecutionAttempts < 1 || policy.maxExecutionAttempts > 5 ||
      !Number.isSafeInteger(policy.retryDelayMs) || policy.retryDelayMs < 0 || policy.retryDelayMs > 900_000) {
    return invalid("invalid verification retry budgets");
  }
  return policy;
}

/** ADR-0047: the barrier stage directly follows implementation, hosts preparation, and implementation is unit-gated. */
function unitExecutionPolicy(workflow: CompiledWorkflow, policy: NonNullable<CompiledWorkflow["verification"]>) {
  const units = workflow.unitExecution;
  if (!units) return undefined;
  const implementation = workflow.stages.findIndex((stage) => stage.name === policy.implementationStage);
  if (workflow.stages[implementation + 1]?.name !== units.barrierStage || (policy.preparationStage && policy.preparationStage !== units.barrierStage)) {
    return invalid("unit execution requires the barrier stage to directly follow implementation and to be the preparation stage");
  }
  if (workflow.stage(policy.implementationStage)?.gate?.type !== "unit-progress") return invalid("unit execution requires a unit-progress gate on the implementation stage");
  if (!Number.isSafeInteger(units.maxCodeAttempts) || units.maxCodeAttempts < 0 || units.maxCodeAttempts > 10 ||
      !Number.isSafeInteger(units.maxExecutionAttempts) || units.maxExecutionAttempts < 1 || units.maxExecutionAttempts > 5) {
    return invalid("invalid unit execution retry budgets");
  }
  return units;
}

export class VerificationService implements CandidateSnapshots, VerificationContracts, VerificationActions, VerificationApprovalGuard, VerificationPublicationGuard, AgentCheckRequests, AgentBaselineRequests, AgentCheckLogReader, AgentToolOffering, StageEntryPolicy, StageResumptionPolicy, PlanReconfirmation, PublicationRecovery {
  private readonly d: {
    namespace: string; reader: ResourceReader; writer: ResourceWriter; compiler: WorkflowCompiler;
    snapshots: WorkspaceSnapshotter; environments: ExecutionEnvironmentSelector; scheduler: CheckRunScheduler;
    events: EventRecorder; clock: Clock; redactor: Redactor;
    recoveryChecks?: RecoveryCheckAuthorization;
    logs?: TranscriptReader;
    planning?: PlanningReviewBinding;
    /** ADR-0048: unresolved AI plan review findings need an explicit human reason, never block the human. */
    planReview?: PlanningReviewOutcome;
    /** ADR-0047: required when a workflow enables unit execution; missing means construction cannot proceed. */
    completeness?: CandidateCompleteness;
  };
  readonly gates: (GateEvaluator & ApprovalGateEvaluator)[];

  constructor(d: VerificationService["d"]) {
    this.d = d;
    this.gates = [this.reviewGate("verification-plan-review", "plan"), this.reviewGate("verification-candidate-review", "candidate"), {
      type: "verified-checks", evaluate: (ctx) => this.evaluateChecks(ctx),
      evaluateApproval: (ctx: GateContext, approval: Approval) => this.afterApproval(ctx, approval),
    } satisfies GateEvaluator & ApprovalGateEvaluator];
  }

  private async item(name: string) {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item) throw new StoreError("work item not found", "NotFound");
    return item;
  }

  async plan(item: WorkItem, approved: boolean): Promise<ValidationContract> {
    if (!item.spec.workflowRef) return invalid("work item has no workflow");
    const compiled = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (compiled.planning && !this.d.planning) return invalid("planning review binding is unavailable; construction cannot proceed without it");
    const policy = verificationPolicy(compiled);
    const unitPolicy = unitExecutionPolicy(compiled, policy);
    const runs = await this.d.reader.list<AgentRun>("AgentRun", owned(item));
    const eligibleRuns = new Set(runs.filter((r) => eligible(r) && r.spec.stage === policy.planningStage &&
      r.status?.phase === "Succeeded" && r.status.executor && r.status.executor !== "simulated" &&
      r.status.provenance?.executor && r.status.provenance.executor !== "simulated" &&
      r.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid)).map((r) => r.metadata.name));
    const artifacts = await this.d.reader.list<Artifact>("Artifact", owned(item));
    const artifact = artifacts.filter((a) => eligible(a) && a.spec.artifactTypeRef.name === "validation-plan" &&
      eligibleRuns.has(a.spec.producedBy?.agentRunRef?.name ?? "")).at(-1);
    if (!artifact) return invalid("a current real validation-plan artifact is required; restart validation planning");
    const specification = artifacts.filter((a) => eligible(a) && a.spec.artifactTypeRef.name === "spec").at(-1);
    const producer = runs.find((r) => r.metadata.name === artifact.spec.producedBy?.agentRunRef?.name);
    const samePlannerRun = !!compiled.planning?.plannerStage &&
      producer?.spec.stage === compiled.planning.plannerStage &&
      specification?.spec.producedBy?.agentRunRef.name === producer.metadata.name;
    if (!specification || (!samePlannerRun &&
        producer?.status?.provenance?.inputs[specification.metadata.name] !== specification.metadata.resourceVersion)) {
      return invalid("validation-plan must be produced from the current specification revision");
    }
    const { plan, repositories } = await this.contents(item, artifact.spec.content, policy, unitPolicy);
    const workflowVersions = compiled.versions ?? {};
    const planningBinding = await this.d.planning?.binding(item);
    const fingerprint = digest([item.metadata.uid, specification.metadata.uid, specification.metadata.resourceVersion, artifact.metadata.uid, artifact.metadata.resourceVersion, plan,
      workflowVersions, repositories.map((r) => [r.metadata.name, r.metadata.resourceVersion]),
      ...(planningBinding ? [planningBinding] : [])]);
    const contract: ValidationContract = { artifact, plan, fingerprint, workflowVersions, repositories, policy, unitPolicy };
    if (approved) {
      await this.d.planning?.assertReady(item);
      const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
      if (approvedBinding(approvals, item, "plan", fingerprint, policy.reviewStage)) return contract;
      const original = reconfirmed(approvals, item, fingerprint, policy.reviewStage);
      if (original) return { ...contract, fingerprint: original };
      return invalid(`No human approval matches the current plan: the specification, validation plan or planning decisions are unapproved or changed since approval. Restart from ${policy.reviewStage} for fresh human approval.`);
    }
    return contract;
  }

  /** ADR-0054: re-confirm an unchanged approved plan in place when only workflow/repository definitions changed. */
  async request(item: WorkItem, stage: CompiledStage): Promise<GateDecision | undefined> {
    if (!item.spec.workflowRef) return undefined;
    const wf = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (!wf.verification) return undefined;
    try {
      const policy = verificationPolicy(wf);
      const index = (name: string) => wf.stages.findIndex((s) => s.name === name);
      if (index(stage.name) <= index(policy.reviewStage)) return undefined;
      const contract = await this.plan(item, false);
      const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
      if (approvedBinding(approvals, item, "plan", contract.fingerprint, policy.reviewStage) ||
          reconfirmed(approvals, item, contract.fingerprint, policy.reviewStage)) return undefined;
      const previous = approvals.filter((a) => a.spec.stage === policy.reviewStage && a.spec.verification?.kind === "plan" &&
        !a.spec.verification.rebinds && a.spec.decision && a.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid)).at(-1);
      if (previous?.spec.decision !== "approve" || !previous.spec.decidedBy) return undefined;
      const { content, specification } = await this.content(item, contract);
      if (previous.spec.verification!.content !== undefined ? previous.spec.verification!.content !== content : !specification ||
          // Approvals before ADR-0054 have no content digest. resourceVersion is a global monotonic counter, so artifacts
          // last written before the decision was recorded are what the human approved; anything else fails closed.
          ![contract.artifact, specification].every((a) => Number(a.metadata.resourceVersion) < Number(previous.metadata.resourceVersion))) {
        return undefined;
      }
      return { action: "await-approval", approvers: wf.stage(policy.reviewStage)?.gate?.approvers ?? [],
        verification: { kind: "plan", fingerprint: contract.fingerprint, planFingerprint: contract.fingerprint, rebinds: previous.spec.verification!.fingerprint, content },
        criteria: [
          `Plan re-confirmation: the specification and validation plan approved at ${policy.reviewStage} by ${previous.spec.decidedBy} are unchanged, but workflow or repository definitions changed since then.`,
          `Approve to continue at ${stage.name} under the current definitions. Existing code review and check evidence stays valid; current checks and repository policy still apply.`,
          `Reject to revise the plan from ${wf.planning?.revisionStage ?? policy.planningStage}.`,
          ...gapCriterion(planGaps(contract)),
        ] };
    } catch (e) { if (!isStoreError(e, "Invalid")) throw e; return undefined; }
  }

  private async content(item: WorkItem, contract: ValidationContract) {
    const specification = (await this.d.reader.list<Artifact>("Artifact", owned(item)))
      .filter((a) => eligible(a) && a.spec.artifactTypeRef.name === "spec").at(-1);
    return { specification, content: digest([item.metadata.uid, specification?.metadata.uid, specification?.metadata.resourceVersion,
      contract.artifact.metadata.uid, contract.artifact.metadata.resourceVersion, contract.plan]) };
  }

  async decide(item: WorkItem, stage: CompiledStage, approval: Approval): Promise<GateDecision> {
    const wf = await this.d.compiler.compile(item.spec.workflowRef!, nsOf(item));
    try {
      const policy = verificationPolicy(wf);
      if (approval.spec.decision === "reject") return { action: "goto", stage: wf.planning?.revisionStage ?? policy.planningStage };
      await this.validate(approval, "approve", approval.spec.comment);
      return { action: "goto", stage: stage.name };
    } catch (e) { if (!isStoreError(e, "Invalid")) throw e; return { action: "block", questions: [e.message] }; }
  }

  /** Content and policy validation of one validation-plan artifact (no approval or planning-revision binding). */
  private async contents(item: WorkItem, content: string, policy: NonNullable<CompiledWorkflow["verification"]>,
    unitPolicy: CompiledWorkflow["unitExecution"]): Promise<{ plan: ValidationPlan; repositories: Repository[] }> {
    let raw: unknown;
    try { raw = JSON.parse(content); }
    catch (e) { if (!(e instanceof SyntaxError)) throw e; return invalid("validation-plan must contain a JSON object, not Markdown"); }
    if (!raw || typeof raw !== "object" || !("checks" in raw) || !strings(raw.checks) ||
        !("preflight" in raw) || !strings(raw.preflight) || !("criteria" in raw) || !Array.isArray(raw.criteria) || !raw.criteria.length) {
      return invalid("validation-plan requires checks[], preflight[] and nonempty criteria[]");
    }
    const criteria: ValidationPlan["criteria"] = [];
    for (const criterion of raw.criteria) {
      if (!criterion || typeof criterion !== "object" || typeof criterion.id !== "string" || !criterion.id.trim() ||
          typeof criterion.description !== "string" || !criterion.description.trim() || !strings(criterion.checks) || !criterion.checks.length) {
        return invalid("each acceptance criterion needs an id, description and named check mappings");
      }
      if (criteria.some((c) => c.id === criterion.id)) return invalid("acceptance criterion IDs must be unique");
      criteria.push({ id: criterion.id, description: criterion.description, checks: criterion.checks });
    }
    const plan: ValidationPlan = { checks: raw.checks, preflight: raw.preflight, criteria };
    if (new Set(plan.checks).size !== plan.checks.length || new Set(plan.preflight).size !== plan.preflight.length) return invalid("duplicate plan check identities");
    const repositories: Repository[] = [];
    for (const ref of item.spec.repositoryRefs ?? []) {
      const repo = await resolveRef<Repository>(this.d.reader, "Repository", ref, nsOf(item));
      if (!repo?.spec.verification) return invalid(`repository ${ref.name} needs explicit verification policy`);
      repositories.push(repo);
      if (!repo.spec.verification.requiredChecks.length || !repo.spec.verification.preflightChecks.length) return invalid(`repository ${ref.name} needs mandatory checks and preflight`);
      for (const check of repo.spec.verification.requiredChecks) {
        if (!plan.checks.includes(`${repo.metadata.name}/${check}`)) return invalid(`plan omits required check ${repo.metadata.name}/${check}`);
      }
      for (const check of repo.spec.verification.preflightChecks) {
        if (!plan.preflight.includes(`${repo.metadata.name}/${check}`) || !repo.spec.checks?.[check]) return invalid(`plan requires configured preflight ${repo.metadata.name}/${check}`);
      }
      for (const check of repo.spec.verification.preparationChecks ?? []) {
        if (!policy.preparationStage || !repo.spec.checks?.[check] || !plan.checks.includes(`${repo.metadata.name}/${check}`)) {
          return invalid(`preparation ${repo.metadata.name}/${check} needs a preparation stage and a configured check in the reviewed plan`);
        }
      }
    }
    if (!repositories.length) return invalid("verified workflows need a repository");
    for (const id of [...plan.checks, ...plan.preflight]) {
      const [repository, check, extra] = id.split("/");
      const repo = repositories.find((r) => r.metadata.name === repository);
      if (!repo || !check || extra || ![...Object.keys(repo.spec.checks ?? {}), ...repo.spec.verification!.requiredChecks].includes(check)) return invalid(`unknown policy check ${id}`);
      if (plan.preflight.includes(id) && !repo.spec.verification!.preflightChecks.includes(check)) return invalid(`unapproved preflight ${id}`);
    }
    const mandatory = new Set(repositories.flatMap((r) => r.spec.verification!.requiredChecks.map((check) => `${r.metadata.name}/${check}`)));
    const untraced = plan.checks.filter((id) => !mandatory.has(id) && !criteria.some((c) => c.checks.includes(id)));
    const unknown = [...new Set(criteria.flatMap((c) => c.checks.filter((id) => !plan.checks.includes(id))))];
    if (unknown.length || untraced.length) {
      // Operator-mandatory checks are justified by policy; optional checks must say which criterion they prove.
      return invalid(`every criterion and optional verification check needs a complete traceability mapping${unknown.length ? `; criteria reference checks missing from checks[]: ${unknown.join(", ")}` : ""}${untraced.length ? `; optional checks no criterion maps: ${untraced.join(", ")}` : ""}`);
    }
    if (unitPolicy) {
      const manifest = parseUnitManifest("units" in raw ? raw.units : undefined, plan, repositories);
      if ("error" in manifest) return invalid(manifest.error);
      plan.units = manifest.units;
    }
    return { plan, repositories };
  }

  /** ADR-0049: structure check right after the validation-plan step, so malformed plans are fixed by their author. */
  readonly artifactCheck: ProposedArtifactCheck = {
    artifactType: "validation-plan",
    check: async ({ item, content }) => {
      if (!item.spec.workflowRef) return undefined;
      const compiled = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
      if (!compiled.verification) return undefined;
      try {
        const policy = verificationPolicy(compiled);
        await this.contents(item, content, policy, unitExecutionPolicy(compiled, policy));
        return undefined;
      } catch (e) {
        if (!isStoreError(e, "Invalid")) throw e;
        return e.message;
      }
    },
  };

  async candidate(item: WorkItem, contract: ValidationContract): Promise<CandidateState> {
    const workspaces = (await this.d.reader.list<Workspace>("Workspace", owned(item))).filter((w) =>
      w.status?.phase === "Ready" && w.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid));
    const { health } = await this.d.environments.select();
    const snapshots: Record<string, string> = {};
    const profiles: Record<string, string> = {};
    for (const repo of contract.repositories) {
      const ws = workspaces.find((w) => w.spec.repositoryRef.name === repo.metadata.name);
      if (!ws) return invalid(`Ready owned workspace missing for ${repo.metadata.name}`);
      snapshots[ws.metadata.name] = await this.d.snapshots.fingerprint(ws);
      const profile = repo.spec.sandboxRef && await resolveRef<SandboxProfile>(this.d.reader, "SandboxProfile", repo.spec.sandboxRef, nsOf(item));
      if (repo.spec.sandboxRef && !profile) return invalid("sandbox profile no longer exists");
      profiles[repo.metadata.name] = profile?.metadata.resourceVersion ?? "default";
    }
    return { workspaces, snapshots, profiles, health, fingerprint: digest([contract.fingerprint, workspaces.map((w) => [w.metadata.name, w.metadata.uid, snapshots[w.metadata.name]]),
      health.runtime, health.version, profiles]) };
  }

  /**
   * ADR-0063: stage entry. Permission first; on entering the verify stage, the plan's verification checks are collected
   * for the approved candidate before the verifier runs, so it evaluates complete evidence.
   */
  async beforeStage(item: WorkItem, stage: CompiledStage): Promise<GateDecision> {
    const permission = await this.stagePermission(item, stage);
    if (permission.action !== "advance" || !item.spec.workflowRef) return permission;
    const wf = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (!wf.verification || stage.name !== verificationPolicy(wf).verifyStage) return permission;
    try {
      const contract = await this.plan(item, true);
      const candidate = await this.candidateApproved(item, contract);
      return await this.collectChecks(item, stage, contract, candidate, false) ?? { action: "advance" };
    } catch (e) { return this.checkError(e); }
  }

  /** Side-effect free: may the item be at this stage with its current plan and candidate? */
  private async stagePermission(item: WorkItem, stage: CompiledStage): Promise<GateDecision> {
    if (!item.spec.workflowRef) return { action: "advance" };
    const wf = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (!wf.verification) return { action: "advance" };
    try {
      if ((await this.beforeResume(item)).action === "wait") return { action: "wait", retryAfterMs: 1000 };
      const policy = verificationPolicy(wf);
      if (wf.stages.findIndex((s) => s.name === stage.name) <= wf.stages.findIndex((s) => s.name === policy.reviewStage)) return { action: "advance" };
      const contract = await this.plan(item, true);
      if (stage.name === contract.policy.preflightStage) return { action: "advance" };
      const state = await this.candidate(item, contract);
      if (!state.health.available) return invalid("verification environment is unavailable; restore it before construction");
      const runs = await this.d.reader.list<CheckRun>("CheckRun", owned(item));
      for (const id of contract.plan.preflight) {
        const [repository, check] = id.split("/");
        const ws = state.workspaces.find((w) => w.spec.repositoryRef.name === repository)!;
        const repo = contract.repositories.find((r) => r.metadata.name === repository)!;
        if (!runs.some((r) => eligible(r) && r.spec.workItemUid === item.metadata.uid && r.spec.workspaceUid === ws.metadata.uid &&
            r.spec.repositoryVersion === repo.metadata.resourceVersion && r.spec.workflow?.planFingerprint === contract.fingerprint &&
            r.spec.workflow.purpose === "preflight" && r.spec.check === check && r.status?.phase === "Completed" && r.status.outcome === "Passed" &&
            !r.status.logsIncomplete && r.spec.environment.runtime === state.health.runtime && r.spec.environment.version === state.health.version &&
            r.spec.environment.profileVersion === state.profiles[repository])) return invalid(`preflight ${id} is missing or stale; restart preflight before construction`);
      }
      if (contract.unitPolicy && wf.stages.findIndex((s) => s.name === stage.name) > wf.stages.findIndex((s) => s.name === contract.policy.implementationStage)) {
        if (!this.d.completeness) return invalid("unit completeness barrier is unavailable; review cannot start");
        const barrier = await this.d.completeness.beforeCandidate(item, stage, contract);
        if (barrier.action !== "advance") return barrier;
      }
      if (stage.name === contract.policy.preparationStage) return this.prepareCandidate(item, stage, contract, state, runs);
      if (stage.name === contract.policy.verifyStage) {
        const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
        if (!approvedBinding(approvals, item, "candidate", state.fingerprint)) {
          const review = contract.policy.preparationStage ? wf.stage(contract.policy.preparationStage)! :
            wf.stages.slice(wf.stages.findIndex(candidate => candidate.name === contract.policy.implementationStage) + 1,
              wf.stages.findIndex(candidate => candidate.name === contract.policy.verifyStage))
              .find(candidate => candidate.gate?.type === "verification-candidate-review")!;
          if ((item.status?.retries?.["candidate-drift"] ?? 0) >= contract.policy.maxExecutionAttempts) {
            return { action: "block", questions: [`Candidate drift exhausted ${contract.policy.maxExecutionAttempts} return-to-review attempts. Inspect preparation/check snapshots and generation stability; explicitly restart ${review.name} after correcting the cause. An answer is not candidate approval.`] };
          }
          return { action: "goto", stage: review.name, retryOf: "candidate-drift" };
        }
      }
      return { action: "advance" };
    } catch (e) { if (!isStoreError(e, "Invalid")) throw e; return { action: "block", questions: [e.message] }; }
  }

  async beforeResume(item: WorkItem): Promise<GateDecision> {
    const runs = await this.d.reader.list<CheckRun>("CheckRun", owned(item));
    return runs.some((run) => run.spec.workItemUid === item.metadata.uid && active(run))
      ? { action: "wait", retryAfterMs: 1000 } : { action: "advance" };
  }

  private async prepareCandidate(item: WorkItem, stage: CompiledStage, contract: ValidationContract,
    state: CandidateState, runs: CheckRun[]): Promise<GateDecision> {
    for (const repo of contract.repositories) {
      const ws = state.workspaces.find((workspace) => workspace.spec.repositoryRef.name === repo.metadata.name)!;
      for (const check of repo.spec.verification?.preparationChecks ?? []) {
        const attempts = runs.filter((run) => eligible(run) && run.spec.workItemUid === item.metadata.uid &&
          run.spec.workspaceUid === ws.metadata.uid && run.spec.repositoryVersion === repo.metadata.resourceVersion &&
          run.spec.check === check && run.spec.workflow?.purpose === "preparation" && run.spec.workflow.stage === stage.name &&
          run.spec.workflow.planFingerprint === contract.fingerprint && run.spec.environment.runtime === state.health.runtime &&
          run.spec.environment.version === state.health.version && run.spec.environment.profileVersion === state.profiles[repo.metadata.name]);
        const last = attempts.at(-1);
        if (last?.status?.phase === "Completed" && last.status.executionOutcome === "Passed" && !last.status.logsIncomplete &&
            last.status.finalSnapshot === state.snapshots[ws.metadata.name] &&
            (last.status.outcome === "Passed" || last.status.outcome === "NotVerified")) continue;
        const currentAttempts = attempts.filter((run) => run.spec.workflow?.round === item.status?.round);
        if (currentAttempts.length >= contract.policy.maxExecutionAttempts) return { action: "block", questions: [
          `Preparation ${repo.metadata.name}/${check} exhausted its execution budget. Inspect CheckRun ${last?.metadata.name}; restore prerequisites or generation stability before explicitly retrying review.`] };
        const retryAt = last?.status?.finishedAt ? Date.parse(last.status.finishedAt) + contract.policy.retryDelayMs : 0;
        if (retryAt > this.d.clock.now().getTime()) return { action: "wait", retryAfterMs: retryAt - this.d.clock.now().getTime() };
        const attempt = currentAttempts.length + 1;
        try {
          await this.d.scheduler.submit({ workItem: item, workspace: ws, repository: repo, check,
            requestId: `preparation/${digest([stage.name, item.status?.round, repo.metadata.name, check, attempt])}`,
            requestedBy: "candidate-preparation", workflow: { stage: stage.name, round: item.status!.round!, purpose: "preparation",
              planFingerprint: contract.fingerprint, attempt } });
        } catch (error) {
          if (isStoreError(error, "Conflict")) return { action: "wait", retryAfterMs: 1000 };
          if (!(error instanceof SandboxUnavailableError)) throw error;
          return { action: "block", questions: [this.d.redactor.redact(`Candidate preparation runtime unavailable: ${error.message}`)] };
        }
        return { action: "wait", retryAfterMs: 1000 };
      }
    }
    return { action: "advance" };
  }

  private async candidateApproved(item: WorkItem, contract: ValidationContract) {
    const candidate = await this.candidate(item, contract);
    const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
    if (!approvedBinding(approvals, item, "candidate", candidate.fingerprint)) {
      return invalid("candidate changed or has not been reviewed; restart code-review for fresh human approval");
    }
    return candidate;
  }

  private reviewGate(type: string, kind: "plan" | "candidate"): GateEvaluator & ApprovalGateEvaluator {
    return {
      type,
      evaluate: async ({ workItem, stage }) => {
        try {
          if (kind === "candidate") {
            const permission = await this.stagePermission(workItem, stage);
            if (permission.action !== "advance") return permission;
          }
          const contract = await this.plan(workItem, kind === "candidate");
          const fingerprint = kind === "plan" ? contract.fingerprint : (await this.candidate(workItem, contract)).fingerprint;
          return { action: "await-approval", verification: { kind, fingerprint, planFingerprint: contract.fingerprint,
            ...(kind === "plan" ? { content: (await this.content(workItem, contract)).content } : {}) },
            ...(kind === "plan" && planGaps(contract).length ? { criteria: gapCriterion(planGaps(contract)) } : {}) };
        } catch (e) {
          if (!isStoreError(e, "Invalid")) throw e;
          return { action: "block", questions: [e.message] };
        }
      },
      evaluateApproval: (ctx, approval) => this.afterApproval(ctx, approval),
    };
  }

  async validate(approval: Approval, decision: "approve" | "reject", comment?: string) {
    if (decision === "reject") return;
    const item = await this.item(approval.spec.workItemRef.name);
    const binding = approval.spec.verification;
    if (!binding) return invalid("verification approval has no binding");
    const contract = await this.plan(item, binding.kind !== "plan");
    await this.d.planning?.assertReady(item);
    const fingerprint = binding.kind === "plan" ? contract.fingerprint
      : binding.kind === "candidate" ? (await this.candidate(item, contract)).fingerprint
      : (await this.evidence(item, contract)).fingerprint;
    if (binding.fingerprint !== fingerprint || binding.planFingerprint !== contract.fingerprint) return invalid("review is stale; plan, policy, environment or candidate changed");
    if (binding.rebinds) {
      const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
      const policy = verificationPolicy(await this.d.compiler.compile(item.spec.workflowRef!, nsOf(item)));
      if (binding.kind !== "plan" || !approvedBinding(approvals, item, "plan", binding.rebinds, policy.reviewStage)) return invalid("the plan approval this re-confirmation carries forward is no longer approved");
      return;
    }
    if (binding.kind === "plan" && await this.d.planReview?.requestsChanges(item) && (comment?.trim().length ?? 0) < 10) {
      return invalid("The AI plan review still requests changes. Approve with a reason (at least 10 characters) explaining why you accept the plan anyway, or request a revision.");
    }
    if (binding.kind !== "plan" && contract.unitPolicy) {
      if (!this.d.completeness) return invalid("unit completeness barrier is unavailable");
      await this.d.completeness.assertComplete(item, contract);
    }
    if (binding.kind === "waiver") {
      const state = await this.evidence(item, contract);
      if (state.unwaivable.length || state.pending || !binding.requirements?.length ||
          digest(binding.requirements) !== digest(state.missing)) return invalid("waiver cannot bypass pending or non-waivable requirements");
      if (!comment || comment.trim().length < 10) return invalid("a verification waiver requires an explicit reason (at least 10 characters)");
    }
  }

  private async afterApproval(ctx: GateContext, approval: Approval): Promise<GateDecision> {
    if (approval.spec.decision === "reject") {
      const workflow = await this.d.compiler.compile(ctx.workItem.spec.workflowRef!, nsOf(ctx.workItem));
      const policy = verificationPolicy(workflow);
      if (approval.spec.verification?.kind === "waiver") return { action: "block", questions: ["Verification waiver rejected. Supply missing evidence or revise the reviewed plan/policy."] };
      return { action: "goto", stage: approval.spec.verification?.kind === "plan"
        ? workflow.planning?.revisionStage ?? policy.planningStage : policy.implementationStage };
    }
    try { await this.validate(approval, "approve", approval.spec.comment); }
    catch (e) { if (!isStoreError(e, "Invalid")) throw e; return { action: "block", questions: [e.message] }; }
    return { action: "advance" };
  }

  private async evidence(item: WorkItem, contract: ValidationContract) {
    const candidate = await this.candidateApproved(item, contract);
    const runs = (await this.d.reader.list<CheckRun>("CheckRun", owned(item))).filter((r) =>
      eligible(r) && r.spec.workItemUid === item.metadata.uid && r.spec.workflow?.planFingerprint === contract.fingerprint);
    const missing: string[] = [];
    const unwaivable: string[] = [];
    for (const id of contract.plan.checks) {
      const [repository, check] = id.split("/");
      const repo = contract.repositories.find((r) => r.metadata.name === repository)!;
      const ws = candidate.workspaces.find((w) => w.spec.repositoryRef.name === repository)!;
      const passed = runs.some((r) => r.spec.workspaceUid === ws.metadata.uid && r.spec.repositoryVersion === repo.metadata.resourceVersion &&
        r.spec.check === check && scopeSatisfies(repo, check, r, "verification") && r.spec.snapshot === candidate.snapshots[ws.metadata.name] &&
        r.status?.outcome === "Passed" && r.status.phase === "Completed" && !r.status.logsIncomplete &&
        r.status.finalSnapshot === r.spec.snapshot && r.spec.environment.runtime === candidate.health.runtime &&
        r.spec.environment.version === candidate.health.version && r.spec.environment.profileVersion === candidate.profiles[repository]);
      if (passed) continue;
      missing.push(id);
      if (!repo.spec.verification?.waivableChecks?.includes(check)) unwaivable.push(id);
    }
    const pending = runs.some(active);
    return { ...candidate, runs, missing, unwaivable, pending,
      fingerprint: digest([candidate.fingerprint, missing, runs.map((r) => [r.metadata.uid, r.metadata.resourceVersion])]) };
  }

  private async evaluateChecks(ctx: GateContext): Promise<GateDecision> {
    const item = ctx.workItem;
    try {
      if ((await this.beforeResume(item)).action === "wait") return { action: "wait", retryAfterMs: 1000 };
      const contract = await this.plan(item, true);
      const preflight = ctx.stage.name === contract.policy.preflightStage;
      if (!preflight && ctx.stage.name !== contract.policy.verifyStage) return { action: "fail", reason: "verified gate is not at a configured verification stage" };
      if (!preflight) {
        const permission = await this.stagePermission(item, ctx.stage);
        if (permission.action !== "advance") return permission;
      }
      const candidate = preflight ? await this.candidate(item, contract) : await this.candidateApproved(item, contract);
      if (!candidate.health.available) return { action: "block", questions: ["Verification environment is unavailable; restore the runtime and explicitly retry preflight. No code-fix retry was charged."] };
      const collected = await this.collectChecks(item, ctx.stage, contract, candidate, preflight);
      if (collected) return collected;
      if (preflight) return { action: "advance" };
      const state = await this.evidence(item, contract);
      if (!state.missing.length) return { action: "advance" };
      if (state.unwaivable.length) return { action: "block", questions: [`Required evidence is missing/stale/incomplete: ${state.unwaivable.join(", ")}. These checks cannot be waived.`] };
      return { action: "await-approval", verification: { kind: "waiver", fingerprint: state.fingerprint, planFingerprint: contract.fingerprint, requirements: state.missing } };
    } catch (e) { return this.checkError(e); }
  }

  private checkError(e: unknown): GateDecision {
    if (e instanceof SandboxUnavailableError) return { action: "block", questions: [this.d.redactor.redact(
      `Verification environment unavailable (${e.runtime}): ${e.message}. Restore the runtime and explicitly retry. No code-fix retry was charged.`)] };
    if (isStoreError(e, "Conflict")) return { action: "wait", retryAfterMs: 1000 };
    if (!isStoreError(e, "Invalid")) throw e;
    return { action: "block", questions: [e.message] };
  }

  /**
   * Submits the next required check without current passing evidence, or decides what its last attempt means (ADR-0042
   * §3). Undefined when every configured required check passed for this candidate; shared by stage entry and the gate.
   */
  private async collectChecks(item: WorkItem, stage: CompiledStage, contract: ValidationContract, candidate: CandidateState,
    preflight: boolean): Promise<GateDecision | undefined> {
    const runs = await this.d.reader.list<CheckRun>("CheckRun", owned(item));
    if (runs.some((r) => r.spec.workItemUid === item.metadata.uid && active(r))) return { action: "wait", retryAfterMs: 1000 };
    const requirements = preflight ? contract.plan.preflight : contract.plan.checks;
    for (const id of requirements) {
      const [repository, check] = id.split("/");
      const repo = contract.repositories.find((r) => r.metadata.name === repository)!;
      const ws = candidate.workspaces.find((w) => w.spec.repositoryRef.name === repository)!;
      if (!repo.spec.checks?.[check]) continue;
      const attempts = runs.filter((r) => eligible(r) && r.spec.workItemUid === item.metadata.uid && r.spec.workspaceUid === ws.metadata.uid &&
        r.spec.check === check && r.spec.workflow?.planFingerprint === contract.fingerprint && r.spec.workflow.purpose === (preflight ? "preflight" : "verification") &&
        r.spec.workflow.stage === stage.name && r.spec.workflow.round === item.status?.round);
      const last = attempts.at(-1);
      if (last?.status?.outcome === "Passed" && !last.status.logsIncomplete && last.spec.snapshot === candidate.snapshots[ws.metadata.name] &&
          last.status.finalSnapshot === last.spec.snapshot && last.spec.repositoryVersion === repo.metadata.resourceVersion) continue;
      if (last?.status?.outcome === "AssertionFailed" && !preflight) {
        if ((item.status?.retries?.[stage.name] ?? 0) < contract.policy.maxCodeAttempts) return { action: "goto", stage: contract.policy.implementationStage, retryOf: stage.name };
        return { action: "block", questions: [`${id}: assertion failure exhausted the code-fix budget. Inspect CheckRun ${last.metadata.name} and its redacted logs.`] };
      }
      if (last && attempts.length >= contract.policy.maxExecutionAttempts) {
        return { action: "block", questions: [`${id}: ${last.status?.outcome ?? "Interrupted"} after ${attempts.length} execution attempts. No code-fix retry was charged. Inspect CheckRun ${last.metadata.name}; fix prerequisites/scope or review the budget, then explicitly retry.`] };
      }
      const retryAt = last?.status?.finishedAt ? Date.parse(last.status.finishedAt) + contract.policy.retryDelayMs : 0;
      if (retryAt > this.d.clock.now().getTime()) return { action: "wait", retryAfterMs: retryAt - this.d.clock.now().getTime() };
      await this.d.scheduler.submit({ workItem: item, workspace: ws, repository: repo, check,
        requestId: `${stage.name}/${item.status?.round}/${id}/${attempts.length + 1}`,
        requestedBy: "verification-gate", workflow: { stage: stage.name, round: item.status!.round!, purpose: preflight ? "preflight" : "verification",
          planFingerprint: contract.fingerprint, attempt: attempts.length + 1 } });
      return { action: "wait", retryAfterMs: 1000 };
    }
    return undefined;
  }

  async tools(ctx: ExecutionContext): Promise<string[]> {
    if (!this.d.recoveryChecks || !ctx.workItem.spec.workflowRef || !ctx.run.spec.assignment ||
        ctx.run.spec.assignment.kind !== "unit" || ctx.run.spec.replayOf || !eligible(ctx.run)) return [];
    const wf = await this.d.compiler.compile(ctx.workItem.spec.workflowRef, nsOf(ctx.workItem));
    if (!wf.recovery || ctx.run.spec.stage !== wf.verification?.implementationStage) return [];
    const agent = await resolveRef<Agent>(this.d.reader, "Agent", ctx.run.spec.agentRef, nsOf(ctx.run));
    if (!agent?.spec.sandboxRef || !(agent.spec.tools ?? []).some((tool) => tool === "run" || tool === "write_file")) return [];
    return ["run_check", ...(ctx.run.spec.recovery?.mode === "diagnosis" ? ["run_baseline_check"] : []), ...(this.d.logs ? ["read_check_log"] : [])]
      .filter((name) => ctx.run.spec.tools === undefined || ctx.run.spec.tools.includes(name));
  }

  async read(ctx: ExecutionContext, input: { checkRun: string; afterSeq?: number; offset?: number }) {
    if (!this.d.logs || ctx.run.spec.replayOf || !eligible(ctx.run)) return invalid("check logs are unavailable to this run");
    const namespace = nsOf(ctx.workItem);
    const item = await this.d.reader.get<WorkItem>("WorkItem", namespace, ctx.workItem.metadata.name);
    const caller = await this.d.reader.get<AgentRun>("AgentRun", namespace, ctx.run.metadata.name);
    const job = await this.d.reader.get<CheckRun>("CheckRun", namespace, input.checkRun);
    if (!item || item.metadata.uid !== ctx.workItem.metadata.uid || !caller || caller.metadata.uid !== ctx.run.metadata.uid ||
        caller.status?.phase !== "Running" || caller.spec.replayOf || !eligible(caller) ||
        caller.spec.tools !== undefined && !caller.spec.tools.includes("read_check_log") ||
        caller.spec.workItemRef.name !== item.metadata.name ||
        caller.spec.workItemRef.namespace && caller.spec.workItemRef.namespace !== namespace ||
        item.status?.stage !== caller.spec.stage || !["Running", "Waiting"].includes(item.status?.phase ?? "") ||
        !caller.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid) ||
        !job || job.spec.workItemUid !== item.metadata.uid ||
        !job.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid) ||
        !job.status?.logRef || job.status.logRef.namespace !== namespace) return invalid("check log is unavailable or not owned by this work item");
    const afterSeq = input.afterSeq ?? 0, offset = input.offset ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(offset) || offset < 0) return invalid("invalid check log cursor");
    const [message] = await this.d.logs.read(job.status.logRef, { afterSeq, limit: 1 });
    if (!message) return { content: "", next: null, logsIncomplete: !!job.status.logsIncomplete };
    const redacted = this.d.redactor.redact(message.content);
    if (offset > redacted.length) return invalid("check log offset exceeds the message length");
    const content = redacted.slice(offset, offset + 6000);
    const next = offset + 6000 < redacted.length ? { afterSeq, offset: offset + 6000 } : { afterSeq: message.seq, offset: 0 };
    return { content, seq: message.seq, next, logsIncomplete: !!job.status.logsIncomplete };
  }

  private async recoveryCheck(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }, baseline = false) {
    if (!this.d.recoveryChecks || !ctx.workItem.spec.workflowRef) return invalid("scoped recovery authorization is unavailable");
    const item = await this.d.reader.get<WorkItem>("WorkItem", nsOf(ctx.workItem), ctx.workItem.metadata.name);
    if (!item || item.metadata.uid !== ctx.workItem.metadata.uid) return invalid("work item identity changed");
    const caller = await this.d.reader.get<AgentRun>("AgentRun", nsOf(item), ctx.run.metadata.name);
    if (!caller || caller.metadata.uid !== ctx.run.metadata.uid) return invalid("agent run identity changed");
    const contract = await this.plan(item, true);
    const assignment = caller.spec.assignment;
    if (!assignment || assignment.kind !== "unit" || assignment.planFingerprint !== contract.fingerprint) return invalid("current approved Unit assignment is required");
    const matches = ctx.workspaces.filter((w) => w.metadata.name === input.workspace || w.spec.repositoryRef.name === input.workspace);
    if (matches.length !== 1) return invalid("unknown or ambiguous workspace");
    const workspace = matches[0];
    const repository = contract.repositories.find((r) => r.metadata.name === workspace.spec.repositoryRef.name);
    if (!repository) return invalid("workspace repository is outside the approved plan");
    const check = input.check.startsWith(`${repository.metadata.name}/`) ? input.check.slice(repository.metadata.name.length + 1) : input.check;
    const diagnostic = caller.spec.recovery?.mode === "diagnosis";
    if (baseline && (!diagnostic || !workspace.status?.baseCommit)) return invalid("baseline check requires a diagnostic run and pinned baseline");
    if (baseline && repository.spec.checks?.[check] !== undefined && isScoped(repository, check)) return invalid("candidate-scoped module selection cannot be applied to a baseline");
    const purpose = baseline ? "baseline" : diagnostic ? "diagnostic" : "unit-readiness";
    const wf = await this.d.compiler.compile(item.spec.workflowRef!, nsOf(item));
    const id = `${repository.metadata.name}/${check}`;
    if (diagnostic ? !wf.recovery?.diagnosticChecks.includes(id) :
      !contract.plan.units?.find((unit) => unit.id === assignment.unit) ||
      !unitChecks(contract.plan.units.find((unit) => unit.id === assignment.unit)!).includes(id)) {
      return invalid("check is outside this Unit's authorized scope");
    }
    const previous = (await this.d.reader.list<CheckRun>("CheckRun", owned(item))).filter((run) =>
      run.spec.workItemUid === item.metadata.uid && run.spec.workflow?.purpose === purpose &&
      run.spec.workflow.planFingerprint === contract.fingerprint && run.spec.workflow.unit === assignment.unit &&
      run.spec.repositoryRef.name === repository.metadata.name && run.spec.check === check);
    const existing = previous.find((run) => run.spec.workflow?.agentRunUid === caller.metadata.uid &&
      run.spec.workflow?.agentRequestId === input.requestId);
    const origin: CheckWorkflowOrigin = { stage: caller.spec.stage, round: item.status!.round!, purpose,
      planFingerprint: contract.fingerprint, attempt: existing?.spec.workflow?.attempt ?? previous.length + 1,
      unit: assignment.unit, ...(diagnostic ? { recoveryEpisode: caller.spec.recovery!.episode,
        ...(baseline ? { baselineCommit: workspace.status!.baseCommit! } : {}) } : { unitRun: caller.metadata.name,
        ...(caller.spec.recovery ? { recoveryEpisode: caller.spec.recovery.episode } : {}) }),
      agentRunRef: { name: caller.metadata.name }, agentRunUid: caller.metadata.uid, agentRequestId: input.requestId };
    await this.d.recoveryChecks.authorize({ item, origin, repository, workspace, check, caller, existing });
    return this.d.scheduler.submit({ workItem: item, workspace, repository, check,
      requestId: `${baseline ? "baseline" : "agent"}/${caller.metadata.uid}/${input.requestId}`, requestedBy: ctx.agent.metadata.name, workflow: origin });
  }

  async runBaseline(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }) {
    if (ctx.run.spec.replayOf || !eligible(ctx.run) || ctx.run.spec.recovery?.mode !== "diagnosis" ||
        ctx.run.spec.tools !== undefined && !ctx.run.spec.tools.includes("run_baseline_check") ||
        !input.requestId?.trim() || input.requestId.length > 140) return invalid("baseline request is not authorized by this diagnostic run");
    return this.recoveryCheck(ctx, input, true);
  }

  async run(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }) {
    if (ctx.run.spec.replayOf || !eligible(ctx.run)) return invalid("replayed or superseded runs cannot request authoritative evidence");
    if (ctx.run.spec.tools !== undefined && !ctx.run.spec.tools.includes("run_check")) return invalid("run_check is excluded by this step's tool restrictions");
    if (!input.requestId?.trim() || input.requestId.length > 200) return invalid("a bounded check requestId is required");
    if (ctx.run.spec.assignment?.kind === "unit" || ctx.run.spec.recovery) return this.recoveryCheck(ctx, input);
    const contract = await this.plan(ctx.workItem, true);
    if (ctx.run.spec.stage !== contract.policy.verifyStage) return invalid("run_check is available only in the verified verification stage");
    const matches = ctx.workspaces.filter((w) => w.metadata.name === input.workspace || w.spec.repositoryRef.name === input.workspace);
    if (matches.length !== 1) return invalid(`unknown or ambiguous workspace; valid values: ${ctx.workspaces.map((w) => `${w.metadata.name} (repository ${w.spec.repositoryRef.name})`).join(", ")}`);
    const workspace = matches[0];
    const repository = contract.repositories.find((r) => r.metadata.name === workspace.spec.repositoryRef.name)!;
    const check = input.check.startsWith(`${repository.metadata.name}/`) ? input.check.slice(repository.metadata.name.length + 1) : input.check;
    if (!contract.plan.checks.includes(`${repository.metadata.name}/${check}`)) return invalid(`check is outside the approved plan for repository ${repository.metadata.name}; valid checks: ${contract.plan.checks.filter((id) => id.startsWith(`${repository.metadata.name}/`)).join(", ")}`);
    const previous = (await this.d.reader.list<CheckRun>("CheckRun", owned(ctx.workItem))).filter((r) =>
      r.spec.workItemUid === ctx.workItem.metadata.uid && r.spec.workflow?.stage === ctx.run.spec.stage &&
      r.spec.workflow.round === ctx.workItem.status?.round && r.spec.check === check &&
      r.spec.workspaceUid === workspace.metadata.uid && r.spec.workflow.planFingerprint === contract.fingerprint);
    const existing = previous.find((run) => run.spec.workflow?.agentRunRef?.name === ctx.run.metadata.name &&
      run.spec.workflow.agentRunUid === ctx.run.metadata.uid && run.spec.workflow.agentRequestId === input.requestId);
    if (!existing && previous.length >= contract.policy.maxExecutionAttempts) {
      throw new StoreError("check execution budget exhausted; the workflow gate will request human attention", "Conflict");
    }
    if (!existing) {
      const compiled = await this.d.compiler.compile(ctx.workItem.spec.workflowRef!, nsOf(ctx.workItem));
      const permission = await this.stagePermission(ctx.workItem, compiled.stage(contract.policy.verifyStage)!);
      if (permission.action !== "advance") throw new StoreError(
        permission.action === "wait" ? "another check is active; wait for its result" : "candidate needs fresh review; the workflow gate will return to code-review",
        "Conflict");
    }
    return this.d.scheduler.submit({ workItem: ctx.workItem, workspace, repository, check,
      requestId: `agent/${ctx.run.metadata.uid}/${input.requestId}`, requestedBy: ctx.agent.metadata.name,
      workflow: { stage: ctx.run.spec.stage, round: ctx.workItem.status!.round!, purpose: "verification", planFingerprint: contract.fingerprint,
        attempt: existing?.spec.workflow?.attempt ?? previous.length + 1,
        agentRunRef: { name: ctx.run.metadata.name }, agentRequestId: input.requestId, agentRunUid: ctx.run.metadata.uid } });
  }

  async recover(item: WorkItem): Promise<GateDecision | undefined> {
    if (!item.spec.workflowRef) return undefined;
    const wf = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (!wf.verification) return undefined;
    try {
      const contract = await this.plan(item, true);
      const permission = await this.stagePermission(item, wf.stage(contract.policy.verifyStage)!);
      return permission.action === "goto" || permission.action === "wait" ? permission : undefined;
    } catch (e) { if (!isStoreError(e, "Invalid")) throw e; return undefined; }
  }

  async check(item: WorkItem) {
    if (!item.spec.workflowRef || !(await this.d.compiler.compile(item.spec.workflowRef, nsOf(item))).verification) return undefined;
    try {
      const contract = await this.plan(item, true);
      const wf = await this.d.compiler.compile(item.spec.workflowRef!, nsOf(item));
      const permission = await this.stagePermission(item, wf.stage(contract.policy.verifyStage)!);
      if (permission.action === "block") return permission.questions.join("; ");
      if (permission.action === "goto") return `the candidate changed after review and verification; it must go through ${permission.stage} again`;
      if (permission.action !== "advance") return "verification prerequisites are not satisfied";
      const state = await this.evidence(item, contract);
      if (state.pending) return "verification checks are still running";
      if (!state.missing.length) return undefined;
      const approvals = await this.d.reader.list<Approval>("Approval", owned(item));
      if (!state.unwaivable.length && approvedBinding(approvals, item, "waiver", state.fingerprint)) return undefined;
      return `publication blocked by missing/stale evidence: ${state.missing.join(", ")}`;
    } catch (e) { if (!isStoreError(e, "Invalid")) throw e; return e.message; }
  }

  async inspect(_p: Principal, name: string): ReturnType<VerificationActions["inspect"]> {
    const item = await this.item(name);
    const enabled = !!item.spec.workflowRef && !!(await this.d.compiler.compile(item.spec.workflowRef, nsOf(item))).verification;
    const result = { enabled, workflow: item.spec.workflowRef?.name, publicationDisabled: item.spec.publicationDisabled === true };
    if (!enabled) return result;
    try {
      const contract = await this.plan(item, false);
      return { ...result, plan: contract.plan, gaps: planGaps(contract) };
    }
    catch (e) { if (!isStoreError(e, "Invalid")) throw e; return { ...result, error: this.d.redactor.redact(e.message) }; }
  }

  async migrate(p: Principal, name: string, input: { workflow: string; requestId: string }) {
    if (!input.workflow?.trim() || !input.requestId?.trim() || input.requestId.length > 200) return invalid("workflow and bounded requestId are required");
    const item = await this.item(name);
    const id = `verification:${input.requestId}`;
    if (item.spec.restart?.id === id) {
      if (item.spec.workflowRef?.name !== input.workflow) throw new StoreError("migration request ID reused with different workflow", "Conflict");
      return item;
    }
    if (!["Failed", "Done", "Closed"].includes(item.status?.phase ?? "")) throw new StoreError("migration requires a stopped work item", "Conflict");
    const checks = await this.d.reader.list<CheckRun>("CheckRun", owned(item));
    const agents = await this.d.reader.list<AgentRun>("AgentRun", owned(item));
    if (checks.some(active) || agents.some((r) => ["Running", "Pending"].includes(r.status?.phase ?? "Pending"))) throw new StoreError("wait for active agents/checks before migration", "Conflict");
    const wf = await this.d.compiler.compile({ name: input.workflow }, nsOf(item));
    if (!wf.verification) return invalid("target workflow is not verification-enabled");
    verificationPolicy(wf);
    const updated = await this.d.writer.update<WorkItem>({ ...item, spec: { ...item.spec, workflowRef: { name: input.workflow }, publicationDisabled: true,
      restart: { id, stage: wf.verification.planningStage, requestedBy: p.id } } });
    await this.d.events.normal(updated, "VerificationMigration", `${p.id}: migrated to ${input.workflow}; fresh validation review required; publication disabled`);
    return updated;
  }
}
