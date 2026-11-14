import type { AgentRun, RetrospectiveFeedback, RetrospectiveFeedbackSpec } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { API_VERSION } from "../model/resource.ts";
import { keyOf, nsOf, parseKey } from "../model/meta.ts";
import { fingerprint } from "../app/work-item-followups.ts";
import { isStoreError, type Controller, type InitialKeys, type Redactor, type ResourceReader, type ResourceWriter } from "../ports/index.ts";
import { FEEDBACK_CAPTURE_RECEIPT, feedbackCaptureRevision, hasControllerFeedback } from "./evidence.ts";

export function createFeedbackCaptureController(d: {
  reader: ResourceReader; writer: ResourceWriter; redactor: Redactor;
}): Controller & InitialKeys {
  return {
    name: "feedback-capture", primaryKind: "AgentRun", watches: ["AgentRun"], resyncMs: 60_000,
    keysFor: (e) => e.type === "DELETED" ? [] : [keyOf(e.object)],
    initialKeys: async () => (await d.reader.list<AgentRun>("AgentRun")).filter((r) => ["Succeeded", "Failed"].includes(r.status?.phase ?? "")).map(keyOf),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const run = await d.reader.get<AgentRun>("AgentRun", namespace, name);
      if (!run || !["Succeeded", "Failed"].includes(run.status?.phase ?? "")) return;
      const revision = feedbackCaptureRevision(run);
      if (!revision || run.metadata.annotations?.[FEEDBACK_CAPTURE_RECEIPT] === revision) return;
      const candidates = [...(run.status?.feedbackCandidates ?? [])];
      // Controller evidence is visibly different and never contributes support.
      if (hasControllerFeedback(run) && run.spec.workflow && run.status) {
        const owner = run.metadata.ownerReferences?.find((o) => o.kind === "WorkItem");
        const spec: RetrospectiveFeedbackSpec = {
          observation: { stage: run.spec.stage, issueCode: "run-failed", stance: "support",
            observation: d.redactor.redact(run.status.message ?? "Agent run failed").slice(0, 1500),
            impact: "The run did not complete.", suggestion: "Inspect the recorded failure before proposing a workflow change.",
            evidence: `AgentRun/${namespace}/${name} (${run.metadata.uid})` },
          target: { ...run.spec.workflow.target, stage: run.spec.stage, workflowVersions: run.spec.workflow.versions },
          reporter: { agent: run.spec.agentRef.name, role: "controller", kind: "controller" },
          origin: { workItem: run.spec.workItemRef.name, workItemUid: owner?.uid ?? "", agentRun: name, agentRunUid: run.metadata.uid ?? "" },
          capturedAt: run.status.finishedAt ?? run.metadata.creationTimestamp!,
          executor: run.status.executor ?? "unknown", verified: false, replay: !!run.spec.replayOf,
          superseded: !!run.metadata.labels?.[LABEL_SUPERSEDED], truncated: (run.status.message?.length ?? 0) > 1500,
        };
        candidates.push(spec);
      }
      for (const [index, spec] of candidates.entries()) {
        const feedbackName = `feedback-${fingerprint([run.metadata.uid, index]).slice(0, 40)}`;
        if (await d.reader.get("RetrospectiveFeedback", namespace, feedbackName)) continue;
        try {
          await d.writer.create<RetrospectiveFeedback>({
            apiVersion: API_VERSION, kind: "RetrospectiveFeedback",
            metadata: { name: feedbackName, namespace: nsOf(run) },
            spec,
          });
        } catch (e) {
          if (!isStoreError(e, "AlreadyExists")) throw e;
        }
      }
      // A deterministic audit record makes resync/restart safe even for rejected observations.
      if (run.status?.feedbackWarnings?.length) {
        try {
          await d.writer.create({
            apiVersion: API_VERSION, kind: "Event", metadata: { name: `feedback-warning-${run.metadata.uid}`, namespace,
              labels: { "factory.ai-dlc.io/workitem": run.spec.workItemRef.name } },
            spec: { involvedObject: { kind: "AgentRun", name, uid: run.metadata.uid }, type: "Warning",
              reason: "FeedbackRejected", message: run.status.feedbackWarnings.join(" ") },
          });
        } catch (e) { if (!isStoreError(e, "AlreadyExists")) throw e; }
      }
      await d.writer.update({ ...run, metadata: { ...run.metadata,
        annotations: { ...run.metadata.annotations, [FEEDBACK_CAPTURE_RECEIPT]: revision } } });
    },
  };
}
