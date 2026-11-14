import type { AgentRun, Approval, Artifact, CheckRun, Clarification, Repository, Source, WorkItem, WorkItemStatus, Workspace } from "../../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../../model/kinds.ts";
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
  type VerificationPublicationGuard,
} from "../../ports/index.ts";
import { routeToDecision } from "../../model/routes.ts";
import { resolveRef } from "../../refs/refs.ts";

const TERMINAL = new Set(["Done", "Closed", "Failed"]);
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
}

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
      status.phase === "Blocked" ? "AwaitingClarification" : status.phase === "AwaitingApproval" ? "AwaitingApproval" : "NotBlocked",
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

  /** ADR-0023: entering a `publish` stage enqueues one pull request per Ready workspace (idempotent per round). */
  async function publishPullRequests(wi: WorkItem, stage: CompiledStage) {
    if (!stage.publish?.pullRequest) return;
    const list = await d.reader.list<Workspace>("Workspace", {
      namespace: nsOf(wi),
      ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) },
    });
    for (const ws of list.filter((w) => w.status?.phase === "Ready")) {
      await d.outbox.enqueue({
        key: `${wi.metadata.name}-${stage.name}-r${wi.status?.round ?? 0}-pr-${ws.spec.repositoryRef.name}`.slice(0, 200),
        namespace: nsOf(wi),
        action: "open-pull-request",
        payload: { workspace: ws.metadata.name, workItem: wi.metadata.name, title: wi.spec.title, draft: stage.publish.pullRequest.draft ?? true },
        owner: ownerRef(wi),
      });
    }
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

  async function block(wi: WorkItem, stage: CompiledStage, questions: string[]) {
    const st = wi.status!;
    const name = `${wi.metadata.name}-${stage.name}-r${st.round}`;
    const c: Clarification = {
      apiVersion: API_VERSION,
      kind: "Clarification",
      metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: wi.metadata.name }, stage: stage.name, questions: questions.length ? questions : [DEFAULT_QUESTION] },
      status: { phase: "Open" },
    };
    await createChild(c);
    await write(wi, { phase: "Blocked", blockedBy: { kind: "Clarification", name } }, "Blocked", `${stage.name}: waiting for clarification`);
  }

  async function apply(wi: WorkItem, wf: CompiledWorkflow, stage: CompiledStage, decision: GateDecision) {
    const round = (wi.status?.round ?? 0) + 1;
    switch (decision.action) {
      case "advance": {
        const next = wf.next(stage.name);
        if (!next) return write(wi, { phase: "Done", blockedBy: undefined }, "Completed", "workflow finished");
        return write(wi, enterStage(wf, next, round), "StageStarted", `${next.name} (${next.lifecyclePhase})`);
      }
      case "goto": {
        const target = wf.stage(decision.stage);
        if (!target) return write(wi, { phase: "Failed", message: `unknown stage ${decision.stage}` }, "Failed", `unknown stage ${decision.stage}`);
        const retries = decision.retryOf
          ? { ...wi.status?.retries, [decision.retryOf]: (wi.status?.retries?.[decision.retryOf] ?? 0) + 1 }
          : wi.status?.retries;
        return write(wi, { ...enterStage(wf, target, round), retries }, "StageStarted", `${target.name} (back from ${stage.name}${decision.retryOf ? `, retry ${retries![decision.retryOf]}` : ""})`);
      }
      case "wait":
        return { requeueAfterMs: decision.retryAfterMs };
      case "end":
        return write(wi, { phase: decision.phase, message: decision.reason, blockedBy: undefined }, decision.phase, decision.reason);
      case "block":
        return block(wi, stage, decision.questions);
      case "fail":
        await d.events.warning(wi, "GateFailed", decision.reason);
        return write(wi, { phase: "Failed", message: decision.reason });
      case "await-approval": {
        const name = `${wi.metadata.name}-${stage.name}-r${wi.status!.round}`;
        const a: Approval = {
          apiVersion: API_VERSION,
          kind: "Approval",
          metadata: { name, namespace: nsOf(wi), ownerReferences: [ownerRef(wi)] },
          spec: {
            workItemRef: { name: wi.metadata.name },
            stage: stage.name,
            approvers: stage.gate?.approvers ?? [],
            criteria: decision.verification ? [
              ...(stage.gate?.criteria ?? []),
              `Verification ${decision.verification.kind} review. Binding: ${decision.verification.fingerprint}`,
              ...(decision.verification.kind === "waiver" ? [
                `Waiver requested for: ${decision.verification.requirements?.join(", ")}. These requirements remain Waived, never Passed.`,
                "Approval requires an explicit reason of at least 10 characters; rejection keeps verification blocked.",
              ] : []),
            ] : stage.gate?.criteria,
            ticketPublication: decision.ticketPublication,
            verification: decision.verification,
            retrospective: decision.retrospective,
          },
          status: { phase: "Pending" },
        };
        await createChild(a);
        return write(wi, { phase: "AwaitingApproval", blockedBy: { kind: "Approval", name } }, "AwaitingApproval", `${stage.name}: waiting for approval`);
      }
    }
  }

  /** Restarts are spec-driven and handled once per `spec.restart.id`; a restart may revive Done/Failed/Closed items. */
  const restartPending = (wi: WorkItem) => !!wi.spec.restart && wi.spec.restart.id !== wi.status?.restartHandled;

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
    watches: ["WorkItem", "AgentRun", "Clarification", "Approval", "Workspace", "CheckRun"],
    keysFor: (e) => (e.object.kind === "WorkItem" ? (e.type === "DELETED" ? [] : [keyOf(e.object)]) : ownerKey(e.object)),
    initialKeys: async () =>
      (await d.reader.list<WorkItem>("WorkItem")).filter((w) => !TERMINAL.has(w.status?.phase ?? "") || restartPending(w)).map(keyOf),
    resyncMs: 60_000,

    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const wi = await d.reader.get<WorkItem>("WorkItem", namespace, name);
      if (!wi || (TERMINAL.has(wi.status?.phase ?? "") && !restartPending(wi))) return;
      try {
        if (wi.spec.retrospectiveOutcome && wi.spec.retrospectiveOutcome.disposition !== "open") {
          return write(wi, { phase: "Closed", blockedBy: undefined }, "Closed", `Retrospective ${wi.spec.retrospectiveOutcome.disposition} by ${wi.spec.retrospectiveOutcome.by}`);
        }
        if (!wi.spec.workflowRef) return write(wi, { phase: "Failed", message: "no workflowRef" }, "Failed", "no workflowRef");
        const wf = await d.compiler.compile(wi.spec.workflowRef, namespace);
        if (restartPending(wi)) return restartItem(wi, wf, wi.spec.restart!);

        if (!wi.status?.phase || wi.status.phase === "New") {
          await ensureWorkspaces(wi);
          const first = wf.stages[0];
          return write(wi, enterStage(wf, first, 1), "StageStarted", `${first.name} (${first.lifecyclePhase})`);
        }
        const st = wi.status;
        const stage = wf.stage(st.stage ?? "");
        if (!stage) return write(wi, { phase: "Failed", message: `unknown stage ${st.stage}` });

        if (st.phase === "Blocked") {
          const c = await d.reader.get<Clarification>("Clarification", namespace, st.blockedBy?.name ?? "");
          if (c && !c.spec.answers?.length) {
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
          const reason = await d.publicationGuard?.check(wi);
          if (reason) return block(wi, stage, [reason]);
        }
        if (stepIdx === 0) await publishPullRequests(wi, stage); // level-triggered; enqueue is idempotent
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
              },
            });
            return;
          }
          const rs = run.status as
            | { phase?: string; result?: { outcome?: string; questions?: string[]; classification?: WorkItemStatus["classification"] }; message?: string; modelWaits?: number }
            | undefined;
          if (rs?.phase === "Failed") {
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
          const r = rs.result ?? {};
          const patch: Partial<WorkItemStatus> = {
            classification: r.classification ? { ...st.classification, ...r.classification } : st.classification,
            lastOutcome: r.outcome ?? st.lastOutcome,
          };
          if (r.questions?.length) {
            await write(wi, { ...patch, ...(st.phase === "Waiting" ? { phase: "Running" as const, message: undefined } : {}) });
            const fresh = (await d.reader.get<WorkItem>("WorkItem", namespace, name))!;
            return block(fresh, stage, r.questions);
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
