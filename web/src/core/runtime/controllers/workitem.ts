import type { Approval, Clarification, WorkItem, WorkItemStatus } from "../../model/kinds.ts";
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
  type ResourceReader,
  type ResourceWriter,
  type StatusWriter,
  type WorkflowCompiler,
} from "../../ports/index.ts";
import { routeToDecision } from "../../model/routes.ts";

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
        return write(wi, enterStage(wf, target, round), "StageStarted", `${target.name} (back from ${stage.name})`);
      }
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
            criteria: stage.gate?.criteria,
          },
          status: { phase: "Pending" },
        };
        await createChild(a);
        return write(wi, { phase: "AwaitingApproval", blockedBy: { kind: "Approval", name } }, "AwaitingApproval", `${stage.name}: waiting for approval`);
      }
    }
  }

  return {
    name: "workitem",
    watches: ["WorkItem", "AgentRun", "Clarification", "Approval"],
    keysFor: (e) => (e.object.kind === "WorkItem" ? (e.type === "DELETED" ? [] : [keyOf(e.object)]) : ownerKey(e.object)),
    initialKeys: async () => (await d.reader.list<WorkItem>("WorkItem")).filter((w) => !TERMINAL.has(w.status?.phase ?? "")).map(keyOf),
    resyncMs: 60_000,

    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const wi = await d.reader.get<WorkItem>("WorkItem", namespace, name);
      if (!wi || TERMINAL.has(wi.status?.phase ?? "")) return;
      try {
        if (!wi.spec.workflowRef) return write(wi, { phase: "Failed", message: "no workflowRef" }, "Failed", "no workflowRef");
        const wf = await d.compiler.compile(wi.spec.workflowRef, namespace);

        if (!wi.status?.phase || wi.status.phase === "New") {
          const first = wf.stages[0];
          return write(wi, enterStage(wf, first, 1), "StageStarted", `${first.name} (${first.lifecyclePhase})`);
        }
        const st = wi.status;
        const stage = wf.stage(st.stage ?? "");
        if (!stage) return write(wi, { phase: "Failed", message: `unknown stage ${st.stage}` });

        if (st.phase === "Blocked") {
          const c = await d.reader.get<Clarification>("Clarification", namespace, st.blockedBy?.name ?? "");
          if (!c?.spec.answers?.length) return;
          return write(wi, enterStage(wf, stage, st.round! + 1), "Resumed", `${stage.name}: clarification answered, re-running stage`);
        }

        if (st.phase === "AwaitingApproval") {
          const a = await d.reader.get<Approval>("Approval", namespace, st.blockedBy?.name ?? "");
          if (!a?.spec.decision) return;
          await d.events.normal(wi, a.spec.decision === "approve" ? "Approved" : "Rejected", `${stage.name} by ${a.spec.decidedBy ?? "unknown"}${a.spec.comment ? `: ${a.spec.comment}` : ""}`);
          const decision: GateDecision =
            a.spec.decision === "approve"
              ? { action: "advance" }
              : routeToDecision<GateDecision>(stage.gate?.onReject, { action: "end", phase: "Closed", reason: "rejected" });
          return apply(wi, wf, stage, decision);
        }

        const stepIdx = st.step ?? 0;
        if (stepIdx < stage.steps.length) {
          const step = stage.steps[stepIdx];
          const rn = runName(wi, stage.name, stepIdx, st.round!);
          const run = await d.reader.get("AgentRun", namespace, rn);
          if (!run) {
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
                inputs: (step.inputs ?? []).map((i) => i.artifactRef),
                outputs: (step.outputs ?? []).map((o) => o.artifactRef),
                modelTier: step.model?.tier,
                outcomes: last && stage.gate?.type === "decision" ? Object.keys(stage.gate.routes ?? {}) : undefined,
              },
            });
            return;
          }
          const rs = run.status as { phase?: string; result?: { outcome?: string; questions?: string[]; classification?: WorkItemStatus["classification"] }; message?: string } | undefined;
          if (rs?.phase === "Failed") {
            await d.events.warning(wi, "AgentRunFailed", `${rn}: ${rs.message ?? ""}`);
            return write(wi, { phase: "Failed", message: `agent run ${rn} failed: ${rs.message ?? ""}` });
          }
          if (rs?.phase !== "Succeeded") return;
          const r = rs.result ?? {};
          const patch: Partial<WorkItemStatus> = {
            classification: r.classification ? { ...st.classification, ...r.classification } : st.classification,
            lastOutcome: r.outcome ?? st.lastOutcome,
          };
          if (r.questions?.length) {
            await write(wi, patch);
            const fresh = (await d.reader.get<WorkItem>("WorkItem", namespace, name))!;
            return block(fresh, stage, r.questions);
          }
          return write(wi, { ...patch, step: stepIdx + 1 });
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
