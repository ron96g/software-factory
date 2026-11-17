import type { AgentRun, Approval, Artifact, CheckRun, Clarification, ClarificationSpec, OutboxMessage, Repository, Source, WorkItem, WorkItemStatus, Workspace } from "../../model/kinds.ts";
import { LABEL_SUPERSEDED, isPublishable } from "../../model/kinds.ts";
import { API_VERSION } from "../../model/resource.ts";
import { keyOf, nsOf, ownerRef, parseKey, setCondition } from "../../model/meta.ts";
import {
  isStoreError,
  type Clock,
  type CompiledStage,
  type CompiledWorkflow,
  type Controller,
  type EventRecorder,
  type GateDecision,
  type GateEvaluatorLookup,
  type InitialKeys,
  type Outbox,
  type WorkspaceSupport,
  type ResourceReader,
  type ResourceWriter,
  type StatusWriter,
  type WorkflowCompiler,
  type ApprovalGateEvaluator,
  type StageEntryPolicy,
  type StageResumptionPolicy,
  type PlanReconfirmation,
  type PublicationRecovery,
  type ReconcileResult,
  type VerificationPublicationGuard,
  type AgentQuestionPolicy,
  type WorkItemIntentPolicy,
  type StepAssignmentPolicy,
  type RunFailurePolicy,
  type ArtifactCheck,
  type Lookup,
  type RecoveryNeedHandler,
  OUTPUT_REJECTED,
} from "../../ports/index.ts";
import { routeToDecision } from "../../model/routes.ts";
import { resolveRef } from "../../refs/refs.ts";
import { createHash } from "node:crypto";
import type { RecoveryEpisode, RecoveryReport } from "../../model/recovery.ts";
import type { RecoveryAllowanceReader, RecoveryRouter } from "../../ports/recovery.ts";

const TERMINAL = new Set(["Done", "Closed", "Failed"]);
import { normalizeQuestions, type AgentQuestion } from "../../questions.ts";
const DEFAULT_QUESTION = "The agent needs more information to continue. Please add details.";

export interface WorkItemControllerDeps {
  reader: ResourceReader;
  writer: ResourceWriter;
  status: StatusWriter;
  events: EventRecorder;
  clock: Clock;
  compiler: WorkflowCompiler;
  gates: GateEvaluatorLookup;
  outbox: Outbox;
  /** Which repositories can get a Workspace (ADR-0021). */
  workspaces: WorkspaceSupport;
  stagePolicy?: StageEntryPolicy;
  resumptionPolicy?: StageResumptionPolicy;
  publicationGuard?: VerificationPublicationGuard;
  /** ADR-0054: stale-only-by-definitions plan approvals are re-confirmed in place instead of blocking. */
  planReconfirmation?: PlanReconfirmation;
  /** ADR-0054: routes an unpublishable-but-recoverable candidate (changed after review, check running) instead of blocking. */
  publicationRecovery?: PublicationRecovery;
  questionPolicy?: AgentQuestionPolicy;
  intentPolicy?: WorkItemIntentPolicy;
  /** ADR-0047: binds an implementation attempt to the next approved Unit. */
  assignments?: StepAssignmentPolicy;
  /** ADR-0047: bounded recovery of failed (e.g. interrupted) runs instead of failing the item. */
  runFailures?: RunFailurePolicy;
  /** ADR-0049: artifact type → structure check, run when the producing step succeeds. */
  artifactChecks?: Lookup<ArtifactCheck>;
  recovery?: RecoveryRouter;
  recoveryNeeds?: Lookup<RecoveryNeedHandler>;
  recoveryAllowances?: RecoveryAllowanceReader;
}

/** Bounded same-step retries for malformed output before the existing gate handling takes over. */
const MAX_OUTPUT_RETRIES = 2;
/** ADR-0053: default automatic resolution attempts for conflicts with the base branch. */
const DEFAULT_CONFLICT_ATTEMPTS = 2;
const BASE_CONFLICT = "base-conflict";

interface BaseConflict { ws: Workspace; base: string; baseCommit: string; files: string[] }

export const runName = (wi: WorkItem, stage: string, step: number, round: number) =>
  `${wi.metadata.name}-${stage}-${step}-r${round}`;

/**
 * Drives a WorkItem through its compiled workflow, one transition per reconcile (controller-pattern skill).
 * Owns WorkItem.status. Creates AgentRuns, Clarifications and Approvals as owned children.
 */
export function createWorkItemController(d: WorkItemControllerDeps): Controller & InitialKeys {
  const ownerKey = (o: { metadata: { namespace?: string; ownerReferences?: { kind: string; name: string }[] } }) => {
    const owner = o.metadata.ownerReferences?.find((r) => r.kind === "WorkItem");
    return owner ? [`${o.metadata.namespace ?? "default"}/${owner.name}`] : [];
  };

  async function write(wi: WorkItem, patch: Partial<WorkItemStatus>, reason?: string, message?: string) {
    const status = { ...(wi.status as WorkItemStatus), ...patch };
    status.conditions = setCondition(
      status.conditions,
      "Blocked",
      status.phase === "Blocked" || status.phase === "AwaitingApproval" ? "True" : "False",
      status.phase === "Blocked" ? status.blockedBy ? "AwaitingClarification" : "HumanAttentionRequired"
        : status.phase === "AwaitingApproval" ? "AwaitingApproval" : "NotBlocked",
      undefined,
      d.clock.now(),
    );
    await d.status.updateStatus({ ...wi, status });
    if (reason) await d.events.normal(wi, reason, message ?? "");
  }

  const enterStage = (wf: CompiledWorkflow, stage: CompiledStage, round: number): Partial<WorkItemStatus> => ({
    phase: "Running",
    stage: stage.name,
    lifecyclePhase: stage.lifecyclePhase,
    step: 0,
    round,
    lastOutcome: undefined,
    blockedBy: undefined,
    message: undefined,
  });

  async function createChild<T extends { metadata: { name: string } }>(obj: T): Promise<void> {
    try {
      await d.writer.create(obj as never);
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e; // idempotent
    }
  }

  /** Rule 7: questions reach Jira/GitHub only via the outbox. Idempotent key per clarification. */
  async function publishQuestions(wi: WorkItem, c: Clarification) {
    if (!wi.spec.externalRef) return;
    const source = await resolveRef<Source>(d.reader, "Source", wi.spec.sourceRef, nsOf(wi));
    if (!source?.spec.sync?.bidirectional) return;
    const body = [
      `**Software Factory needs more information** (stage \`${c.spec.stage}\`):`,
      "",
      ...c.spec.questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      "_Reply to this issue to answer; the work item resumes automatically._",
    ].join("\n");
    await d.outbox.enqueue({
      key: `${c.metadata.name}-questions`,
      namespace: nsOf(wi),
      source: source.metadata.name,
      externalId: wi.spec.externalRef.id,
      action: "comment",
      payload: { body },
      owner: ownerRef(wi),
    });
  }

  /** ADR-0021: one Workspace per supported repository, created once when the item starts. Idempotent names. */
  async function ensureWorkspaces(wi: WorkItem) {
    for (const ref of wi.spec.repositoryRefs ?? []) {
      const repo = await resolveRef<Repository>(d.reader, "Repository", ref, nsOf(wi));
      if (!repo || !d.workspaces.supports(repo)) continue;
      await createChild<Workspace>({
        apiVersion: API_VERSION,
        kind: "Workspace",
        metadata: {
          name: `${wi.metadata.name}-${repo.metadata.name}`.slice(0, 200),
          namespace: nsOf(wi),
          ownerReferences: [ownerRef(wi)],
          labels: { "factory.ai-dlc.io/workitem": wi.metadata.name, "factory.ai-dlc.io/repository": repo.metadata.name },
        },
        spec: {
          workItemRef: { name: wi.metadata.name },
          repositoryRef: { name: repo.metadata.name },
          baseRef: repo.spec.workspace?.baseRef,
          branch: `factory/${wi.metadata.name}`,
          setup: repo.spec.workspace?.setup,
        },
      });
    }
  }

  const pullRequestKey = (wi: WorkItem, stage: CompiledStage, ws: Workspace) =>
    `${wi.metadata.name}-${stage.name}-r${wi.status?.round ?? 0}-pr-${ws.spec.repositoryRef.name}`.slice(0, 200);
  const ownedWorkspaces = (wi: WorkItem) => d.reader.list<Workspace>("Workspace", {
    namespace: nsOf(wi),
    ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) },
  });

  /** ADR-0023: entering a `publish` stage enqueues one pull request per Ready workspace (idempotent per round). */
  async function publishPullRequests(wi: WorkItem, stage: CompiledStage) {
    if (!stage.publish?.pullRequest) return;
    const list = await ownedWorkspaces(wi);
    for (const ws of list.filter((w) => w.status?.phase === "Ready")) {
      // Without a git remote a pull request can never be delivered; the changes stay in the workspace (shown on the stage).
      const repository = await resolveRef<Repository>(d.reader, "Repository", ws.spec.repositoryRef, nsOf(wi));
      if (!repository || !isPublishable(repository)) continue;
      await d.outbox.enqueue({
        key: pullRequestKey(wi, stage, ws),
        namespace: nsOf(wi),
        action: "open-pull-request",
        payload: { workspace: ws.metadata.name, workItem: wi.metadata.name, title: wi.spec.title, draft: stage.publish.pullRequest.draft ?? true },
        owner: ownerRef(wi),
      });
    }
  }

  /**
   * ADR-0053: this round's pull requests are "pending" until delivered (the stage's agents and gate must not act on
   * an unpublished or conflicting candidate). Failed deliveries keep the pre-ADR behaviour: visible, not blocking.
   */
  async function publicationState(wi: WorkItem, stage: CompiledStage): Promise<"pending" | BaseConflict[]> {
    const conflicts: BaseConflict[] = [];
    for (const ws of await ownedWorkspaces(wi)) {
      const msg = await d.reader.get<OutboxMessage>("OutboxMessage", nsOf(wi), pullRequestKey(wi, stage, ws));
      if (!msg) continue;
      if (msg.status?.phase === "Pending" || msg.status?.phase === "Delivering") return "pending";
      const r = msg.status?.phase === "Delivered" ? msg.status.result : undefined;
      if (r?.conflict === true) {
        conflicts.push({ ws, base: String(r.base ?? ""), baseCommit: String(r.baseCommit ?? ""), files: Array.isArray(r.files) ? r.files.map(String) : [] });
      }
    }
    return conflicts;
  }

  /**
   * ADR-0053: merge the current base into each conflicting workspace (the Workspace controller owns the merge), then
   * hand the markers to the `onConflict` stage (bounded) or to a human. Never publishes a conflicting candidate.
   */
  async function resolveBaseConflicts(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, conflicts: BaseConflict[]) {
    let requested = false;
    const round = wi.status?.round ?? 0;
    const current = (c: BaseConflict) => c.ws.status?.integration?.commit === c.baseCommit && c.ws.status.integration.round === round;
    for (const c of conflicts) {
      if (c.ws.spec.integrate?.commit === c.baseCommit && c.ws.spec.integrate.round === round) continue;
      await d.writer.update<Workspace>({ ...c.ws, spec: { ...c.ws.spec, integrate: { commit: c.baseCommit, ref: c.base, round } } });
      requested = true;
    }
    const summary = conflicts.map((c) => `${c.ws.spec.repositoryRef.name} vs ${c.base}@${c.baseCommit.slice(0, 10)}: ${c.files.join(", ") || "(unknown files)"}`).join("; ");
    if (requested) {
      await d.events.warning(wi, "BaseConflict", `pull request not published, merging the current base: ${summary}`);
      return;
    }
    if (!conflicts.every(current)) return; // re-triggered by the Workspace watch
    return handOffConflicts(wi, wf, stage, conflicts);
  }

  async function handOffConflicts(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, conflicts: BaseConflict[]) {
    const failed = conflicts.filter((c) => c.ws.status?.integration?.error);
    const route = stage.publish?.pullRequest?.onConflict;
    const used = wi.status?.retries?.[BASE_CONFLICT] ?? 0;
    if (!failed.length && route?.next && used < (route.maxAttempts ?? DEFAULT_CONFLICT_ATTEMPTS)) {
      return apply(wi, wf, stage, { action: "goto", stage: route.next, retryOf: BASE_CONFLICT });
    }
    const where = conflicts.map((c) => `- \`${c.ws.spec.repositoryRef.name}\` (branch \`${c.ws.spec.branch}\`, workspace \`${c.ws.status?.path ?? "?"}\`): ${
      c.ws.status?.integration?.error ? `merging ${c.base} failed: ${c.ws.status.integration.error}` : `markers left in ${c.files.join(", ")}`}`).join("\n");
    return block(wi, stage, [
      `The pull request conflicts with the current \`${conflicts[0].base}\` branch${failed.length ? " and the factory could not merge it" : ` and ${used} automatic resolution attempt(s) did not resolve it`}. ` +
      (failed.length ? "Fix the cause in the workspace (or restart the item), then answer to retry the merge." :
        "Resolve the conflict markers in the workspace (or restart the item), then answer to publish again."),
    ], { gate: BASE_CONFLICT }, where);
  }

  /**
   * ADR-0054: base merges whose markers no earlier stage has worked on since (e.g. the item was restarted at the
   * publish stage after the merge). An answered base-conflict clarification counts as handled by a human.
   */
  async function unresolvedIntegrations(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage): Promise<BaseConflict[]> {
    const merged = (await ownedWorkspaces(wi)).filter((ws) => ws.status?.integration && (ws.status.integration.conflicts.length || ws.status.integration.error));
    if (!merged.length) return [];
    const owned = { namespace: nsOf(wi), ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) } };
    const before = new Set(wf.stages.slice(0, wf.stages.findIndex((s) => s.name === stage.name)).map((s) => s.name));
    const runs = (await d.reader.list<AgentRun>("AgentRun", owned)).filter((r) => before.has(r.spec.stage) && !r.spec.replayOf);
    const answered = (await d.reader.list<Clarification>("Clarification", owned)).filter((c) => c.spec.askedBy?.gate === BASE_CONFLICT && c.spec.answers?.length);
    const after = (at: string | undefined, since: string) => !!at && Date.parse(at) >= Date.parse(since);
    return merged.filter((ws) => {
      const since = ws.status!.integration!.at;
      return !runs.some((r) => after(r.metadata.creationTimestamp, since)) && !answered.some((c) => after(c.status?.answeredAt ?? c.metadata.creationTimestamp, since));
    }).map((ws) => ({ ws, base: ws.status!.integration!.ref, baseCommit: ws.status!.integration!.commit, files: ws.status!.integration!.conflicts }));
  }

  /** "ready" | "waiting" | failure message */
  async function workspacesState(wi: WorkItem): Promise<"ready" | "waiting" | string> {
    const list = await d.reader.list<Workspace>("Workspace", {
      namespace: nsOf(wi),
      ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) },
    });
    const failed = list.find((w) => w.status?.phase === "Failed");
    if (failed) return `workspace ${failed.metadata.name} failed: ${failed.status?.message ?? ""}`;
    return list.every((w) => w.status?.phase === "Ready") ? "ready" : "waiting";
  }

  async function block(wi: WorkItem, stage: CompiledStage, questions: string[], askedBy: ClarificationSpec["askedBy"], details?: string, options?: string[][]) {
    const st = wi.status!;
    const name = `${wi.metadata.name}-${stage.name}-r${st.round}`;
    const c: Clarification = {
      apiVersion: API_VERSION,
      kind: "Clarification",
      metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: wi.metadata.name }, stage: stage.name, questions: questions.length ? questions : [DEFAULT_QUESTION], askedBy,
        ...(options?.some((o) => o.length) ? { options } : {}),
        ...(details?.trim() ? { details } : {}) },
      status: { phase: "Open" },
    };
    await createChild(c);
    await write(wi, { phase: "Blocked", blockedBy: { kind: "Clarification", name } }, "Blocked", `${stage.name}: waiting for clarification`);
  }

  async function gateBlock(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, questions: string[], gate: string, details?: string): Promise<ReconcileResult | void> {
    const reconfirm = await d.planReconfirmation?.request(wi, stage);
    if (reconfirm) return apply(wi, wf, stage, reconfirm);
    return block(wi, stage, questions, { gate }, details);
  }

  async function apply(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, decision: GateDecision) {
    const round = (wi.status?.round ?? 0) + 1;
    switch (decision.action) {
      case "advance": {
        const next = wf.next(stage.name);
        const recovery = wi.status?.recovery?.map((e) => e.disposition === "repairing" ? { ...e, disposition: "resolved" as const } : e);
        if (!next) return write(wi, { phase: "Done", blockedBy: undefined, recovery }, "Completed", "workflow finished");
        return write(wi, { ...enterStage(wf, next, round), recovery }, "StageStarted", `${next.name} (${next.lifecyclePhase})`);
      }
      case "goto": {
        const target = wf.stage(decision.stage);
        if (!target) return write(wi, { phase: "Failed", message: `unknown stage ${decision.stage}` }, "Failed", `unknown stage ${decision.stage}`);
        const retries = decision.retryOf
          ? { ...wi.status?.retries, [decision.retryOf]: (wi.status?.retries?.[decision.retryOf] ?? 0) + 1 }
          : wi.status?.retries;
        return write(wi, { ...enterStage(wf, target, round), retries,
          recovery: wi.status?.recovery?.map((e) => e.disposition === "repairing" ? { ...e, disposition: "resolved" as const } : e) }, "StageStarted", `${target.name} (back from ${stage.name}${decision.retryOf ? `, retry ${retries![decision.retryOf]}` : ""})`);
      }
      case "wait":
        return { requeueAfterMs: decision.retryAfterMs };
      case "end":
        return write(wi, { phase: decision.phase, message: decision.reason, blockedBy: undefined }, decision.phase, decision.reason);
      case "block":
        return gateBlock(wi, wf, stage, decision.questions, stage.gate?.type ?? stage.name, decision.details);
      case "attention":
        return write(wi, { phase: "Blocked", blockedBy: undefined, message: decision.reason }, "PlanningNeedsAttention", decision.reason);
      case "fail":
        await d.events.warning(wi, "GateFailed", decision.reason);
        return write(wi, { phase: "Failed", message: decision.reason });
      case "recovery": {
        const policy = wf.recovery;
        if (!policy || !d.recovery || !wi.metadata.uid) return write(wi, { phase: "Failed", message: "Recovery policy or engine unavailable." });
        const trigger = await d.reader.get<AgentRun | CheckRun>(decision.trigger.kind, nsOf(wi), decision.trigger.name);
        if (!trigger || trigger.metadata.uid !== decision.trigger.uid) return write(wi, { phase: "Failed", message: "Recovery trigger is unavailable or stale." });
        const id = createHash("sha256").update(JSON.stringify([wi.metadata.uid, decision.planFingerprint, decision.unit, policy.version, decision.trigger])).digest("hex").slice(0, 24);
        const episodes = wi.status?.recovery ?? [];
        const previous = episodes.find((e) => e.id === id);
        if (previous) return write(wi, { phase: "Failed", message: `Recovery episode ${id} already consumed this trigger.` });
        const episode: RecoveryEpisode = { id, workItemUid: wi.metadata.uid, planFingerprint: decision.planFingerprint,
          unit: decision.unit, stage: stage.name, policyVersion: policy.version, maxTotalAttempts: policy.maxTotalAttempts,
          operatorAllowance: 0, trigger: decision.trigger, diagnosticAttempts: 0, codeAttempts: 0, executionAttempts: 0,
          failureSignature: d.recovery.signature(trigger), disposition: "diagnosing" };
        return write(wi, { phase: "Running", blockedBy: undefined, recovery: [...episodes.map((e) =>
          e.disposition === "repairing" && e.planFingerprint === episode.planFingerprint && e.unit === episode.unit ? { ...e, disposition: "resolved" as const } : e), episode] },
          "RecoveryStarted", `${decision.unit}: diagnosing ${trigger.kind}/${trigger.metadata.name}`);
      }
      case "await-approval": {
        const name = `${wi.metadata.name}-${stage.name}-r${wi.status!.round}`;
        const a: Approval = {
          apiVersion: API_VERSION,
          kind: "Approval",
          metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)] },
          spec: {
            workItemRef: { name: wi.metadata.name },
            stage: stage.name,
            approvers: decision.approvers ?? stage.gate?.approvers ?? [],
            criteria: decision.verification ? [
              ...(stage.gate?.criteria ?? []),
              `Verification ${decision.verification.kind} ${decision.verification.rebinds ? "re-confirmation" : "review"}. Binding: ${decision.verification.fingerprint}`,
              ...(decision.verification.kind === "waiver" ? [
                `Waiver requested for: ${decision.verification.requirements?.join(", ")}. These requirements remain Waived, never Passed.`,
                "Approval requires an explicit reason of at least 10 characters; rejection keeps verification blocked.",
              ] : []),
              ...(decision.criteria ?? []),
            ] : decision.criteria ? [...(stage.gate?.criteria ?? []), ...decision.criteria] : stage.gate?.criteria,
            ticketPublication: decision.ticketPublication,
            verification: decision.verification,
            retrospective: decision.retrospective,
          },
          status: { phase: "Pending" },
        };
        await createChild(a);
        return write(wi, { phase: "AwaitingApproval", blockedBy: { kind: "Approval", name }, message: undefined }, "AwaitingApproval", `${stage.name}: waiting for approval`);
      }
    }
  }

  /** Restarts are spec-driven and handled once per `spec.restart.id`; a restart may revive Done/Failed/Closed items. */
  const restartPending = (wi: WorkItem) => !!wi.spec.restart && wi.spec.restart.id !== wi.status?.restartHandled;

  async function diagnose(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, episode: RecoveryEpisode) {
      const policy = wf.recovery!;
      const router = d.recovery!;
      const episodes = wi.status?.recovery ?? [];
      const scope = episodes.filter((e) => e.workItemUid === wi.metadata.uid && e.planFingerprint === episode.planFingerprint && e.unit === episode.unit);
      const checkHistory = await d.reader.list<CheckRun>("CheckRun", { namespace: nsOf(wi),
        ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) } });
      const used = scope.reduce((n, e) => n + e.diagnosticAttempts + e.codeAttempts + e.executionAttempts, 0) +
        checkHistory.filter((c) => c.spec.workItemUid === wi.metadata.uid && ["diagnostic", "baseline"].includes(c.spec.workflow?.purpose ?? "") &&
          c.spec.workflow?.planFingerprint === episode.planFingerprint && c.spec.workflow?.unit === episode.unit).length;
      const allowance = scope.reduce((n, e) => n + e.operatorAllowance, 0);
      const allocations = scope.reduce((sum, e) => ({
        diagnosis: sum.diagnosis + (e.operatorAllocations?.diagnosis ?? 0),
        repair: sum.repair + (e.operatorAllocations?.repair ?? 0),
        execution: sum.execution + (e.operatorAllocations?.execution ?? 0),
      }), { diagnosis: 0, repair: 0, execution: 0 });
      const limit = episode.maxTotalAttempts + allowance - (scope.some((e) => e.humanNeedConsumed) ? 0 : policy.humanNeedReserve);
      const updateEpisode = (patch: Partial<RecoveryEpisode>) => episodes.map((e) => e.id === episode.id ? { ...e, ...patch } : e);
      const stop = async (reason: string, report?: RecoveryEpisode["latestReport"]) => {
        const latest = report ?? episode.latestReport;
        const detail = `${reason} ${latest ? `Last eligible report: ${latest.name}.` : "No valid recovery report was produced; original trigger evidence is retained."}`;
        await d.events.warning(wi, "RecoveryExhausted", detail);
        return write(wi, { phase: "Failed", message: detail, recovery: updateEpisode({ ...(report ? { latestReport: report } : {}), disposition: "failed" }) });
      };
      const retryDiagnosis = async (reason: string, report?: RecoveryEpisode["latestReport"]) => {
        await d.events.warning(wi, "RecoveryDiagnosisRejected", reason);
        const ceiling = (policy.maxDiagnosisAttempts ?? 2) + allocations.diagnosis + (scope.some((e) => e.humanNeedConsumed) ? 1 : 0);
        if (episode.diagnosticAttempts >= ceiling || used >= limit) return stop(reason, report);
        return write(wi, { phase: "Running", message: reason, recovery: updateEpisode({
          ...(report ? { latestReport: report } : {}), diagnosticAttempts: episode.diagnosticAttempts + 1 }) },
          "RecoveryDiagnosing", `${episode.unit}: retrying diagnosis after rejected output or interruption.`);
      };
      if (episode.policyVersion !== policy.version || episode.maxTotalAttempts !== policy.maxTotalAttempts) return stop("Recovery policy changed; fresh authorization is required.");
      if (episode.diagnosticAttempts === 0) {
        if (used >= limit) return stop("Recovery hard attempt limit reached; inspect the retained evidence.");
        return write(wi, { recovery: updateEpisode({ diagnosticAttempts: 1 }) }, "RecoveryDiagnosing", `${episode.unit}: diagnostic attempt 1`);
      }
      const name = `${wi.metadata.name.slice(0, 130)}-recovery-${episode.id}-d${episode.diagnosticAttempts}`;
      const run = await d.reader.get<AgentRun>("AgentRun", nsOf(wi), name);
      if (!run) {
        const active = await d.reader.list<CheckRun>("CheckRun", { namespace: nsOf(wi), ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) } });
        if (active.some((c) => c.spec.workItemUid === wi.metadata.uid && (!c.status || c.status.phase === "Running"))) return { requeueAfterMs: 1000 };
        const step = stage.steps[0];
        if (!step) return stop("The implementation stage has no diagnostic agent.");
        const allowed = ["read_file", "list_files", "search_code", "run_check", "run_baseline_check", "read_check_log"];
        const tools = step.tools === undefined ? allowed : allowed.filter((tool) => step.tools!.includes(tool));
        const assignment = { kind: "unit" as const, planFingerprint: episode.planFingerprint, unit: episode.unit };
        await createChild<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun",
          metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)], labels: { "factory.ai-dlc.io/workitem": wi.metadata.name, "factory.ai-dlc.io/stage": stage.name } },
          spec: { workItemRef: { name: wi.metadata.name }, agentRef: step.agentRef, skillRefs: [], stage: stage.name,
            step: `diagnosis-${episode.id}`, inputs: (step.inputs ?? []).map((i) => i.artifactRef), outputs: [{ name: "recovery-report" }],
            tools, assignment, recovery: { episode: episode.id, attempt: episode.diagnosticAttempts, mode: "diagnosis",
              planFingerprint: episode.planFingerprint, unit: episode.unit, policyVersion: episode.policyVersion, trigger: episode.trigger } } });
        return;
      }
      if (!run.status || run.status.phase === "Pending" || run.status.phase === "Running") return;
      if (run.status.phase !== "Succeeded") return retryDiagnosis(`Diagnostic attempt ${name} failed: ${run.status.message ?? "no report"}`);
      const refs = run.status.outputs ?? [];
      const artifacts = await Promise.all(refs.map((ref) => d.reader.get<Artifact>("Artifact", nsOf(wi), ref.name)));
      const reportArtifact = artifacts.find((a) => a?.spec.artifactTypeRef.name === "recovery-report");
      if (!reportArtifact?.metadata.resourceVersion) return retryDiagnosis(`Diagnostic attempt ${name} produced no durable recovery report.`);
      const problem = await d.artifactChecks?.get("recovery-report")?.check(wi, reportArtifact);
      if (!d.artifactChecks?.get("recovery-report") || problem) return retryDiagnosis(`Invalid recovery report: ${problem ?? "validation unavailable"}`);
      const report = JSON.parse(reportArtifact.spec.content) as RecoveryReport;
      const latestReport = { name: reportArtifact.metadata.name, resourceVersion: reportArtifact.metadata.resourceVersion };
      const route = await router.route({ item: wi, episode, policy, run, report });
      if (route.action === "human-need") {
        const handler = d.recoveryNeeds?.get(route.need.kind);
        const trigger = await d.reader.get<AgentRun | CheckRun>(episode.trigger.kind, nsOf(wi), episode.trigger.name);
        if (!handler || !trigger || !policy.humanNeedReserve || scope.some((e) => e.humanNeedConsumed || e.humanNeed)) {
          return write(wi, { phase: "Failed", message: "The proposed human need is not independently verified or its reserve was used.",
            recovery: updateEpisode({ latestReport, disposition: "failed" }) });
        }
        const state = await handler.inspect({ item: wi, trigger, need: route.need });
        if (state === "invalid") return write(wi, { phase: "Failed", message: "The proposed human need is not independently verified.",
          recovery: updateEpisode({ latestReport, disposition: "failed" }) });
        if (state === "satisfied") return retryDiagnosis("The runtime is available again; retrying with the remaining ordinary budget.", latestReport);
        const waits = episode.runtimeWaits ?? 0;
        const waitLimit = wf.unitExecution?.maxExecutionAttempts ?? 0;
        if (waits < waitLimit) {
          const delay = Math.min(60_000, Math.max(1000, wf.verification?.retryDelayMs ?? 1000) * 2 ** waits);
          const retryAt = new Date(d.clock.now().getTime() + delay).toISOString();
          return write(wi, { phase: "Waiting", message: `Waiting for ${route.need.runtime} before requesting human action.`,
            recovery: updateEpisode({ latestReport, disposition: "waiting", runtimeWaits: waits + 1, retryAt }) },
            "RecoveryWaiting", `Runtime unavailable; retry at ${retryAt}.`);
        }
        const name = `${wi.metadata.name.slice(0, 130)}-recovery-${episode.id}`;
        const clarification: Clarification = { apiVersion: API_VERSION, kind: "Clarification",
          metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)] },
          spec: { workItemRef: { name: wi.metadata.name }, stage: stage.name,
            questions: [route.need.need], options: [route.need.options], askedBy: { agentRunRef: { name: run.metadata.name } },
            details: `Restore runtime ${route.need.runtime}, or stop. Evidence: ${latestReport.name}@${latestReport.resourceVersion}.` },
          status: { phase: "Open" } };
        await createChild(clarification);
        return write(wi, { phase: "Blocked", blockedBy: { kind: "Clarification", name }, recovery: updateEpisode({
          latestReport, humanNeed: { ...route.need, clarification: name }, disposition: "blocked" }) },
          "RecoveryHumanNeed", route.need.need);
      }
      if (route.action === "diagnose") {
        if (episode.diagnosticAttempts >= (policy.maxDiagnosisAttempts ?? 2) + allocations.diagnosis +
            (scope.some((e) => e.humanNeedConsumed) ? 1 : 0) || used >= limit) {
          await write(wi, { recovery: updateEpisode({ latestReport }) });
          const fresh = await d.reader.get<WorkItem>("WorkItem", nsOf(wi), wi.metadata.name);
          if (!fresh) return;
          return write(fresh, { phase: "Failed", message: "Recovery diagnosis budget exhausted.", recovery: fresh.status!.recovery!.map((e) => e.id === episode.id ? { ...e, disposition: "failed" as const } : e) });
        }
        return write(wi, { recovery: updateEpisode({ latestReport, diagnosticAttempts: episode.diagnosticAttempts + 1 }) },
          "RecoveryDiagnosing", `${episode.unit}: diagnostic attempt ${episode.diagnosticAttempts + 1}`);
      }
      if (route.action === "repair" || route.action === "execution-recovery") {
        const priorRepairs = scope.filter((e) => e.repairSignature === episode.failureSignature && e.latestReport);
        const failed = episode.trigger.kind === "CheckRun" ? await d.reader.get<CheckRun>("CheckRun", nsOf(wi), episode.trigger.name) : undefined;
        const references = report.evidence.filter((e) => e.kind === "CheckRun");
        const evidence = await Promise.all(references.map((ref) => d.reader.get<CheckRun>("CheckRun", nsOf(wi), ref.name)));
        const observations = [...new Set(evidence.filter((check): check is CheckRun => !!check && !!failed &&
          check.spec.repositoryRef.name === failed.spec.repositoryRef.name && check.spec.check === failed.spec.check &&
          check.spec.workflow?.purpose !== "baseline" && check.status?.phase === "Completed" && check.status.outcome === "AssertionFailed")
          .map((check) => router.signature(check)))].sort();
        const seen = new Set(priorRepairs.flatMap((e) => e.repairEvidence ?? []));
        const prior = route.action === "repair" && priorRepairs.length > 0 &&
          (priorRepairs.some((e) => !e.repairEvidence) || !observations.some((observation) => !seen.has(observation)));
        const codeUsed = scope.reduce((n, e) => n + e.codeAttempts, 0);
        const execUsed = scope.reduce((n, e) => n + e.executionAttempts, 0);
        const baseCeiling = route.action === "repair" ? wf.unitExecution?.maxCodeAttempts : wf.unitExecution?.maxExecutionAttempts;
        const ceiling = baseCeiling === undefined ? undefined : baseCeiling +
          (route.action === "repair" ? allocations.repair : allocations.execution);
        if (prior && episode.diagnosticAttempts < (policy.maxDiagnosisAttempts ?? 2) + allocations.diagnosis +
            (scope.some((e) => e.humanNeedConsumed) ? 1 : 0) && used < limit) {
          return write(wi, { recovery: updateEpisode({ latestReport, diagnosticAttempts: episode.diagnosticAttempts + 1 }) },
            "RecoveryDiagnosing", `${episode.unit}: unchanged failure needs new evidence before another repair.`);
        }
        if (prior || used >= limit || ceiling === undefined || (route.action === "repair" ? codeUsed : execUsed) >= ceiling) {
          return write(wi, { phase: "Failed", message: prior ? "The failure is unchanged after a repair; inspect the report." : "Recovery attempt budget exhausted.",
            recovery: updateEpisode({ latestReport, disposition: "failed" }) });
        }
        const patch = route.action === "repair" ? { codeAttempts: episode.codeAttempts + 1 } : { executionAttempts: episode.executionAttempts + 1 };
        return write(wi, { ...enterStage(wf, stage, (wi.status?.round ?? 0) + 1), recovery: updateEpisode({
          ...patch, latestReport, nextAttemptMode: route.action,
          ...(route.action === "repair" ? { repairSignature: episode.failureSignature, repairEvidence: observations } : {}),
          disposition: "repairing" }) }, "RecoveryRepairing", `${episode.unit}: ${route.action}`);
      }
      return write(wi, { phase: "Failed", message: route.action === "stop" ? route.reason : "Unknown recovery route.",
        recovery: updateEpisode({ latestReport, disposition: "failed" }) });
    }
  /**
   * Re-enters `restart.stage` (default: first) with a fresh round. Artifacts from that stage onward are labelled
   * superseded so agents don't read stale (e.g. simulated) output; history stays visible. Each step is idempotent.
   */
  async function restartItem(wi: WorkItem, wf: CompiledWorkflow, restart: NonNullable<WorkItem["spec"]["restart"]>) {
    const target = restart.stage ? wf.stage(restart.stage) : wf.stages[0];
    if (!target) {
      await d.events.warning(wi, "RestartIgnored", `unknown stage "${restart.stage}"`);
      return write(wi, { restartHandled: restart.id });
    }
    const ns = nsOf(wi);
    const owned = { kind: "WorkItem", name: wi.metadata.name, namespace: ns };
    const affected = new Set(wf.stages.slice(wf.stages.findIndex((s) => s.name === target.name)).map((s) => s.name));
    if (restart.supersedeFrom) {
      const previous = await d.compiler.compile({ name: restart.supersedeFrom.workflow }, ns);
      const previousStart = previous.stages.findIndex((stage) => stage.name === restart.supersedeFrom!.stage);
      if (previousStart < 0) throw new Error(`unknown previous workflow restart stage "${restart.supersedeFrom.stage}"`);
      for (const stage of previous.stages.slice(previousStart)) affected.add(stage.name);
    }
    const supersede = { [LABEL_SUPERSEDED]: restart.id };
    const runs = await d.reader.list<AgentRun>("AgentRun", { namespace: ns, ownedBy: owned });
    const runStage = new Map(runs.map((r) => [r.metadata.name, r.spec.stage]));
    for (const a of await d.reader.list<Artifact>("Artifact", { namespace: ns, ownedBy: owned })) {
      const stage = runStage.get(a.spec.producedBy?.agentRunRef?.name ?? "");
      if (!stage || !affected.has(stage) || a.metadata.labels?.[LABEL_SUPERSEDED]) continue;
      await d.writer.update<Artifact>({ ...a, metadata: { ...a.metadata, labels: { ...a.metadata.labels, ...supersede } } });
    }
    for (const r of runs) {
      if (!affected.has(r.spec.stage) || r.metadata.labels?.[LABEL_SUPERSEDED]) continue;
      await d.writer.update<AgentRun>({ ...r, metadata: { ...r.metadata, labels: { ...r.metadata.labels, ...supersede } } });
    }
    for (const check of await d.reader.list<CheckRun>("CheckRun", { namespace: ns, ownedBy: owned })) {
      if (!check.spec.workflow || !affected.has(check.spec.workflow.stage) || check.metadata.labels?.[LABEL_SUPERSEDED]) continue;
      await d.writer.update<CheckRun>({ ...check, metadata: { ...check.metadata, labels: { ...check.metadata.labels, ...supersede } } });
    }
    // Questions and approval requests of restarted stages can no longer be acted on; history keeps them as superseded.
    for (const c of await d.reader.list<Clarification>("Clarification", { namespace: ns, ownedBy: owned })) {
      if (c.spec.answers?.length || !affected.has(c.spec.stage) || c.metadata.labels?.[LABEL_SUPERSEDED]) continue;
      await d.writer.update<Clarification>({ ...c, metadata: { ...c.metadata, labels: { ...c.metadata.labels, ...supersede } } });
    }
    for (const a of await d.reader.list<Approval>("Approval", { namespace: ns, ownedBy: owned })) {
      if (a.spec.decision || !affected.has(a.spec.stage) || a.metadata.labels?.[LABEL_SUPERSEDED]) continue;
      await d.writer.update<Approval>({ ...a, metadata: { ...a.metadata, labels: { ...a.metadata.labels, ...supersede } } });
    }
    await ensureWorkspaces(wi);
    const round = (wi.status?.round ?? 0) + 1;
    return write(
      wi,
      { ...enterStage(wf, target, round), retries: undefined, loopExhausted: undefined, restartHandled: restart.id },
      "Restarted",
      `from ${target.name}${restart.requestedBy ? ` by ${restart.requestedBy}` : ""}`,
    );
  }

  return {
    name: "workitem",
    primaryKind: "WorkItem",
    watches: ["WorkItem", "AgentRun", "Clarification", "Approval", "Workspace", "CheckRun", "OutboxMessage"],
    keysFor: (e) => (e.object.kind === "WorkItem" ? (e.type === "DELETED" ? [] : [keyOf(e.object)]) : ownerKey(e.object)),
    initialKeys: async () =>
      (await d.reader.list<WorkItem>("WorkItem")).filter((w) => !TERMINAL.has(w.status?.phase ?? "") || restartPending(w) ||
        (w.status?.phase === "Failed" && !!w.status.recovery?.some((e) => e.disposition === "failed"))).map(keyOf),
    resyncMs: 60_000,

    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const wi = await d.reader.get<WorkItem>("WorkItem", namespace, name);
      if (!wi) return;
      try {
        if (wi.status?.phase === "Failed" && d.recoveryAllowances) {
          const found = await d.recoveryAllowances.approved(wi);
          const approval = found?.approval;
          if (approval?.spec.recoveryAllowance) {
            const allowance = approval.spec.recoveryAllowance;
            const episode = wi.status.recovery?.find((e) => e.id === allowance.episode);
            let staleReason = found?.staleReason;
            if (!episode) staleReason ??= "The recovery episode no longer exists.";
            if (!staleReason && episode && allowance.target !== "diagnosis") {
              const artifact = await d.reader.get<Artifact>("Artifact", namespace, allowance.report.name);
              const producerName = artifact?.spec.producedBy?.agentRunRef.name;
              const producer = producerName && await d.reader.get<AgentRun>("AgentRun", namespace, producerName);
              if (!artifact || !producer || !d.recovery) staleReason = "The original report producer is unavailable.";
              else {
                let report: RecoveryReport | undefined;
                try { report = JSON.parse(artifact.spec.content) as RecoveryReport; }
                catch (error) { if (!(error instanceof SyntaxError)) throw error; }
                if (!report || !wi.spec.workflowRef) staleReason = "The original recovery report is invalid.";
                else {
                  const workflow = await d.compiler.compile(wi.spec.workflowRef, namespace);
                  const activeEpisode = { ...episode, disposition: "diagnosing" as const };
                  const activeItem = { ...wi, status: { ...wi.status, recovery: wi.status.recovery!.map((e) => e.id === episode.id ? activeEpisode : e) } };
                  if (!workflow.recovery || (await d.recovery.route({ item: activeItem, episode: activeEpisode,
                    policy: workflow.recovery, run: producer, report })).action !== allowance.target) {
                    staleReason = "The approved report does not authorize the requested recovery action.";
                  }
                }
              }
            }
            if (staleReason || !episode) {
              await d.events.warning(wi, "RecoveryAllowanceStale", `${approval.metadata.name}: ${staleReason}`);
              return write(wi, { staleRecoveryAllowances: [...(wi.status.staleRecoveryAllowances ?? []), approval.metadata.name] });
            }
            const recovery = wi.status.recovery!.map((e) => e.id !== episode.id ? e : {
              ...e, operatorAllowance: e.operatorAllowance + allowance.count,
              operatorAllocations: {
                diagnosis: (e.operatorAllocations?.diagnosis ?? 0) + (allowance.target === "diagnosis" ? allowance.count : 0),
                repair: (e.operatorAllocations?.repair ?? 0) + (allowance.target === "repair" ? allowance.count : 0),
                execution: (e.operatorAllocations?.execution ?? 0) + (allowance.target === "execution-recovery" ? allowance.count : 0),
              },
              consumedAllowances: [...(e.consumedAllowances ?? []), approval.metadata.name],
              disposition: allowance.target === "diagnosis" ? "diagnosing" as const : "repairing" as const,
              diagnosticAttempts: e.diagnosticAttempts + (allowance.target === "diagnosis" ? 1 : 0),
              codeAttempts: e.codeAttempts + (allowance.target === "repair" ? 1 : 0),
              executionAttempts: e.executionAttempts + (allowance.target === "execution-recovery" ? 1 : 0),
              ...(allowance.target === "diagnosis" ? {} : { nextAttemptMode: allowance.target }),
            });
            if (!wi.spec.workflowRef) return;
            const wf = await d.compiler.compile(wi.spec.workflowRef, namespace);
            const stage = wf.stage(episode.stage);
            if (!stage || !wf.recovery || wf.recovery.version !== episode.policyVersion) return;
            return write(wi, { ...enterStage(wf, stage, (wi.status.round ?? 0) + 1), recovery },
              "RecoveryAllowanceConsumed", `Operator ${approval.spec.decidedBy} allocated ${allowance.count} attempt(s) for ${allowance.target}.`);
          }
        }
        if (TERMINAL.has(wi.status?.phase ?? "") && !restartPending(wi)) return;
        if (wi.spec.retrospectiveOutcome && wi.spec.retrospectiveOutcome.disposition !== "open") {
          return write(wi, { phase: "Closed", blockedBy: undefined }, "Closed", `Retrospective ${wi.spec.retrospectiveOutcome.disposition} by ${wi.spec.retrospectiveOutcome.by}`);
        }
        if (!wi.spec.workflowRef) return write(wi, { phase: "Failed", message: "no workflowRef" }, "Failed", "no workflowRef");
        const wf = await d.compiler.compile(wi.spec.workflowRef, namespace);
        if (wf.recovery && !d.recovery) {
          const message = "Technical recovery is not available: durable recovery controller is not wired.";
          return write(wi, { phase: "Failed", message }, "RecoveryUnavailable", message);
        }
        const intent = await d.intentPolicy?.intent(wi);
        if (intent) {
          if (wi.status?.phase === intent.phase && !restartPending(wi)) return;
          return write(wi, { phase: intent.phase, blockedBy: undefined, message: intent.reason,
            restartHandled: wi.spec.restart?.id }, "Closed", intent.reason);
        }
        if (restartPending(wi) && wf.recovery && wi.status?.recovery?.some((e) => e.disposition !== "resolved")) {
          return write(wi, { phase: "Failed", restartHandled: wi.spec.restart!.id,
            message: "Restart cannot reset or bypass an active recovery episode; inspect the retained report." });
        }
        if (restartPending(wi)) return restartItem(wi, wf, wi.spec.restart!);

        if (!wi.status?.phase || wi.status.phase === "New") {
          await ensureWorkspaces(wi);
          const first = wf.stages[0];
          return write(wi, enterStage(wf, first, 1), "StageStarted", `${first.name} (${first.lifecyclePhase})`);
        }
        const st = wi.status;
        const stage = wf.stage(st.stage ?? "");
        if (!stage) return write(wi, { phase: "Failed", message: `unknown stage ${st.stage}` });
        const waitingRecovery = st.recovery?.findLast((e) => e.disposition === "waiting");
        if (waitingRecovery) {
          const delay = Math.max(0, Date.parse(waitingRecovery.retryAt ?? "") - d.clock.now().getTime());
          if (delay > 0) return { requeueAfterMs: delay };
          return write(wi, { phase: "Running", recovery: st.recovery!.map((e) => e.id === waitingRecovery.id
            ? { ...e, disposition: "diagnosing" as const, retryAt: undefined } : e) });
        }
        const diagnosing = st.recovery?.findLast((e) => e.disposition === "diagnosing");
        if (diagnosing && wf.recovery) return diagnose(wi, wf, stage, diagnosing);

        if (st.phase === "Blocked" && !st.blockedBy) {
          // Attention at a gate (e.g. malformed plan evidence) is level-triggered: re-check it on resync so a fixed
          // cause resumes. Gates only ever create human approvals or new stops; this never approves anything.
          const gate = (st.step ?? 0) >= stage.steps.length && stage.gate ? d.gates.get(stage.gate.type) : undefined;
          if (!gate) return;
          const decision = await gate.evaluate({ workItem: wi, stage, gate: stage.gate! });
          if (decision.action === "attention" && decision.reason === st.message) return;
          if (decision.action === "wait") return { requeueAfterMs: decision.retryAfterMs };
          return apply(wi, wf, stage, decision);
        }
        if (st.phase === "Blocked") {
          const c = await d.reader.get<Clarification>("Clarification", namespace, st.blockedBy?.name ?? "");
          const episode = st.recovery?.findLast((e) => e.disposition === "blocked" && e.humanNeed?.clarification === c?.metadata.name);
          if (episode && c?.spec.answers?.length) {
            const need = episode.humanNeed!;
            const handler = d.recoveryNeeds?.get(need.kind);
            const trigger = await d.reader.get<AgentRun | CheckRun>(episode.trigger.kind, namespace, episode.trigger.name);
            if (!handler || !trigger) return write(wi, { phase: "Failed", message: "Recovery need cannot be revalidated." });
            const resolution = handler.resolve({ need, answer: c.spec.answers[0] });
            if (resolution === "invalid") return write(wi, { phase: "Failed", blockedBy: undefined, message: "Recovery answer is not a valid offered option.",
              recovery: st.recovery!.map((e) => e.id === episode.id ? { ...e, disposition: "failed" as const } : e) });
            if (resolution === "stop") return write(wi, { phase: "Failed", blockedBy: undefined, message: "Recovery stopped by the operator.",
              recovery: st.recovery!.map((e) => e.id === episode.id ? { ...e, disposition: "failed" as const } : e) });
            const state = await handler.inspect({ item: wi, trigger, need });
            if (state !== "satisfied") return { requeueAfterMs: 5000 };
            const scope = st.recovery!.filter((e) => e.planFingerprint === episode.planFingerprint && e.unit === episode.unit);
            const checks = await d.reader.list<CheckRun>("CheckRun", { namespace,
              ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace } });
            const used = scope.reduce((n, e) => n + e.diagnosticAttempts + e.codeAttempts + e.executionAttempts, 0) +
              checks.filter((check) => check.spec.workItemUid === wi.metadata.uid && ["diagnostic", "baseline"].includes(check.spec.workflow?.purpose ?? "") &&
                check.spec.workflow?.planFingerprint === episode.planFingerprint && check.spec.workflow?.unit === episode.unit).length;
            const allowance = scope.reduce((n, e) => n + e.operatorAllowance, 0);
            if (scope.some((e) => e.humanNeedConsumed) || used >= episode.maxTotalAttempts + allowance || !c.metadata.resourceVersion) {
              return write(wi, { phase: "Failed", blockedBy: undefined, message: "Recovery human-need reserve is exhausted.",
                recovery: st.recovery!.map((e) => e.id === episode.id ? { ...e, disposition: "failed" as const } : e) });
            }
            return write(wi, { phase: "Running", blockedBy: undefined, recovery: st.recovery!.map((e) => e.id === episode.id ? {
              ...e, disposition: "diagnosing" as const, diagnosticAttempts: e.diagnosticAttempts + 1,
              humanNeedConsumed: { need: `${need.kind}:${need.runtime}`, answerVersion: c.metadata.resourceVersion! },
            } : e) }, "RecoveryResumed", `Runtime ${need.runtime} was restored; reserved attempt consumed.`);
          }
          if (c && !c.spec.answers?.length) {
            const reconfirm = c.spec.askedBy?.gate ? await d.planReconfirmation?.request(wi, stage) : undefined;
            if (reconfirm) return apply(wi, wf, stage, reconfirm);
            await publishQuestions(wi, c);
            return;
          }
          if (!c) return;
          const permission = await d.resumptionPolicy?.beforeResume(wi);
          if (permission?.action === "wait") return { requeueAfterMs: permission.retryAfterMs ?? 1000 };
          return write(wi, enterStage(wf, stage, st.round! + 1), "Resumed", `${stage.name}: clarification answered, re-running stage`);
        }

        if (st.phase === "AwaitingApproval") {
          const a = await d.reader.get<Approval>("Approval", namespace, st.blockedBy?.name ?? "");
          if (!a?.spec.decision) return;
          if (a.spec.verification?.rebinds && d.planReconfirmation) {
            await d.events.normal(wi, a.spec.decision === "approve" ? "Approved" : "Rejected", `${stage.name} plan re-confirmation by ${a.spec.decidedBy ?? "unknown"}${a.spec.comment ? `: ${a.spec.comment}` : ""}`);
            return apply(wi, wf, stage, await d.planReconfirmation.decide(wi, stage, a));
          }
          const evaluator = stage.gate && d.gates.get(stage.gate.type);
          const approvalEvaluator = evaluator as Partial<ApprovalGateEvaluator> | undefined;
          if (approvalEvaluator?.evaluateApproval) {
            return apply(wi, wf, stage, await approvalEvaluator.evaluateApproval({ workItem: wi, stage, gate: stage.gate! }, a));
          }
          await d.events.normal(wi, a.spec.decision === "approve" ? "Approved" : "Rejected", `${stage.name} by ${a.spec.decidedBy ?? "unknown"}${a.spec.comment ? `: ${a.spec.comment}` : ""}`);
          const decision: GateDecision =
            a.spec.decision === "approve"
              ? { action: "advance" }
              : routeToDecision<GateDecision>(stage.gate?.onReject, { action: "end", phase: "Closed", reason: "rejected" });
          return apply(wi, wf, stage, decision);
        }

        const stepIdx = st.step ?? 0;
        if (stage.publish?.pullRequest) {
          if (wi.spec.publicationDisabled) {
            if (st.phase !== "Waiting" || st.message !== "Publication disabled by human policy") return write(wi, { phase: "Waiting", message: "Publication disabled by human policy" }, "PublicationHeld", "No commit, push or pull request will be published.");
            return;
          }
          // This round's delivery result first: merging the base changes the candidate, which the guard would
          // otherwise report as unpublishable before the conflict reaches its resolution route.
          const publication = await publicationState(wi, stage);
          if (publication === "pending") return; // re-triggered by the OutboxMessage watch
          if (publication.length) return resolveBaseConflicts(wi, wf, stage, publication);
          const unresolved = await unresolvedIntegrations(wi, wf, stage);
          if (unresolved.length) return handOffConflicts(wi, wf, stage, unresolved);
          const reason = await d.publicationGuard?.check(wi);
          if (reason) {
            const recovery = await d.publicationRecovery?.recover(wi);
            if (recovery) return apply(wi, wf, stage, recovery);
            return gateBlock(wi, wf, stage, [reason], "publication");
          }
          if (stepIdx === 0) {
            await publishPullRequests(wi, stage); // level-triggered; enqueue is idempotent
            const delivered = await publicationState(wi, stage);
            if (delivered === "pending") return;
            if (delivered.length) return resolveBaseConflicts(wi, wf, stage, delivered);
          }
        }
        else if (stepIdx === 0) await publishPullRequests(wi, stage);
        if (stepIdx < stage.steps.length) {
          const step = stage.steps[stepIdx];
          const rn = runName(wi, stage.name, stepIdx, st.round!);
          const run = await d.reader.get("AgentRun", namespace, rn);
          if (!run) {
            const permission = await d.stagePolicy?.beforeStage(wi, stage);
            if (permission && permission.action !== "advance") return apply(wi, wf, stage, permission);
            const ws = await workspacesState(wi);
            if (ws === "waiting") return; // re-triggered by the Workspace watch
            if (ws !== "ready") return write(wi, { phase: "Failed", message: ws }, "Failed", ws);
            const last = stepIdx === stage.steps.length - 1;
            const assignment = await d.assignments?.assign(wi, stage, stepIdx);
            const episode = wi.status?.recovery?.findLast((e) => e.disposition === "repairing" && e.stage === stage.name &&
              e.planFingerprint === assignment?.planFingerprint && assignment.kind === "unit" && e.unit === assignment.unit);
            if (wf.recovery && assignment?.kind === "unit" && !episode &&
                wi.status?.recovery?.some((e) => e.workItemUid === wi.metadata.uid && e.planFingerprint === assignment.planFingerprint && e.unit === assignment.unit)) {
              return write(wi, { phase: "Failed", message: `Unit ${assignment.unit} has prior recovery history; restart cannot grant a new attempt.` });
            }
            await createChild({
              apiVersion: API_VERSION,
              kind: "AgentRun",
              metadata: {
                name: rn,
                namespace,
                ownerReferences: [ownerRef(wi)],
                labels: { "factory.ai-dlc.io/workitem": wi.metadata.name, "factory.ai-dlc.io/stage": stage.name },
              },
              spec: {
                workItemRef: { name: wi.metadata.name },
                agentRef: step.agentRef,
                skillRefs: step.skillRefs ?? [],
                stage: stage.name,
                step: step.name,
                workflow: wf.versions && stage.originNamespace ? {
                  versions: wf.versions,
                  target: { namespace: stage.originNamespace, name: stage.origin, version: wf.versions[`${stage.originNamespace}/${stage.origin}`] ?? "" },
                  stage: stage.name,
                } : undefined,
                inputs: (step.inputs ?? []).map((i) => i.artifactRef),
                outputs: (step.outputs ?? []).map((o) => o.artifactRef),
                modelTier: step.model?.tier,
                tools: step.tools,
                // Decision-gate routes win on the last step; otherwise a step-declared verdict applies (ADR-0027).
                outcomes: last && stage.gate?.type === "decision"
                  ? Object.keys(stage.gate.routes ?? {})
                  : step.outcomes?.length
                    ? step.outcomes
                    : !last
                      ? undefined
                    : stage.loop
                      ? ["approve", stage.loop.when.outcome]
                      : undefined,
                ...(assignment ? { assignment } : {}),
                ...(episode ? { recovery: { episode: episode.id, attempt: episode.codeAttempts + episode.executionAttempts,
                  mode: episode.nextAttemptMode ?? (episode.codeAttempts ? "repair" : "execution-recovery"), planFingerprint: episode.planFingerprint,
                  unit: episode.unit, policyVersion: episode.policyVersion, trigger: episode.trigger } } : {}),
              },
            });
            return;
          }
          const rs = run.status as
            | { phase?: string; result?: { outcome?: string; questions?: AgentQuestion[]; classification?: WorkItemStatus["classification"] }; message?: string; modelWaits?: number }
            | undefined;
          if (rs?.phase === "Failed") {
            const recovery = await d.runFailures?.recover(wi, stage, run as AgentRun);
            if (recovery) {
              await d.events.warning(wi, "AgentRunInterrupted", `${rn}: ${rs.message ?? ""}`);
              return apply(wi, wf, stage, recovery);
            }
            await d.events.warning(wi, "AgentRunFailed", `${rn}: ${rs.message ?? ""}`);
            return write(wi, { phase: "Failed", message: `agent run ${rn} failed: ${rs.message ?? ""}` });
          }
          if (rs?.phase !== "Succeeded") {
            // Surface a waiting run on the item (ADR-0029/0031). A retry attempt (Running with modelWaits) keeps the
            // item Waiting, so the phase doesn't flicker on every retry.
            const reason = rs?.phase === "Pending" && rs.message ? rs.message : undefined;
            const retrying = rs?.phase === "Running" && (rs.modelWaits ?? 0) > 0;
            if (reason && (st.phase !== "Waiting" || st.message !== reason)) {
              return write(wi, { phase: "Waiting", message: reason }, st.phase === "Waiting" ? undefined : "Waiting", `${stage.name}/${step.name}: ${reason}`);
            }
            if (!reason && !retrying && st.phase === "Waiting") return write(wi, { phase: "Running", message: undefined });
            return;
          }
          const problems: string[] = [];
          const outputArtifacts = await Promise.all(((run as AgentRun).status?.outputs ?? []).map((ref) =>
            d.reader.get<Artifact>("Artifact", namespace, ref.name)));
          for (const expected of (run as AgentRun).spec.outputs) {
            if (d.artifactChecks?.get(expected.name) && !outputArtifacts.some((artifact) => artifact?.spec.artifactTypeRef.name === expected.name)) {
              problems.push(`Missing required output: ${expected.name}`);
            }
          }
          for (const artifact of outputArtifacts) {
            const check = artifact && d.artifactChecks?.get(artifact.spec.artifactTypeRef.name);
            const problem = check && await check.check(wi, artifact);
            if (problem) problems.push(`${artifact.spec.artifactTypeRef.name}: ${problem}`);
          }
          const outputKey = `output:${stage.name}/${step.name}`;
          if (problems.length && (st.retries?.[outputKey] ?? 0) < MAX_OUTPUT_RETRIES) {
            // Only this step reruns (new round); its next attempt sees the exact problem in its context.
            await d.events.warning(wi, OUTPUT_REJECTED, `${stage.name}/${step.name} r${st.round}: ${problems.join("; ")}`);
            return write(wi, { round: st.round! + 1, step: stepIdx, retries: { ...st.retries, [outputKey]: (st.retries?.[outputKey] ?? 0) + 1 },
              ...(st.phase === "Waiting" ? { phase: "Running" as const, message: undefined } : {}) });
          }
          if (problems.length) {
            return apply(wi, wf, stage, { action: "fail",
              reason: `Invalid output from ${stage.name}/${step.name} after ${MAX_OUTPUT_RETRIES} retries: ${problems.join("; ")}. Request a revision to retry.` });
          }
          const r = rs.result ?? {};
          const patch: Partial<WorkItemStatus> = {
            classification: r.classification ? { ...st.classification, ...r.classification } : st.classification,
            lastOutcome: r.outcome ?? st.lastOutcome,
          };
          const asked = normalizeQuestions(r.questions);
          const blockers = asked.filter((q) => q.blocker);
          // Non-blockers are deferred: they stay in result.questions as upstream context for the planner.
          if (blockers.length && !await d.questionPolicy?.deferQuestions(wi, stage)) {
            await write(wi, { ...patch, ...(st.phase === "Waiting" ? { phase: "Running" as const, message: undefined } : {}) });
            const fresh = (await d.reader.get<WorkItem>("WorkItem", namespace, name))!;
            return block(fresh, stage, blockers.map((q) => q.text), { agentRunRef: { name: rn } }, undefined, blockers.map((q) => q.options));
          }
          return write(wi, { ...patch, step: stepIdx + 1, ...(st.phase === "Waiting" ? { phase: "Running" as const, message: undefined } : {}) });
        }

        // Q1: bounded loop back (e.g. AI review requested changes) before the stage's gate.
        if (stage.loop && st.lastOutcome === stage.loop.when.outcome) {
          const used = st.retries?.[stage.name] ?? 0;
          if (used < stage.loop.maxAttempts) return apply(wi, wf, stage, { action: "goto", stage: stage.loop.goto, retryOf: stage.name });
          const marker = `${stage.name}@r${st.round}`;
          if (st.loopExhausted !== marker) {
            // Level-triggered: the status marker makes this happen once; the next reconcile proceeds to the gate.
            return write(wi, { loopExhausted: marker }, "LoopExhausted", `${stage.name}: still "${st.lastOutcome}" after ${used} round(s); handing over to the gate`);
          }
        }
        const evaluator = stage.gate ? d.gates.get(stage.gate.type) : undefined;
        if (stage.gate && !evaluator) {
          return apply(wi, wf, stage, { action: "fail", reason: `no evaluator for gate type "${stage.gate.type}"` });
        }
        const decision = evaluator ? await evaluator.evaluate({ workItem: wi, stage, gate: stage.gate! }) : { action: "advance" as const };
        return apply(wi, wf, stage, decision);
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}
