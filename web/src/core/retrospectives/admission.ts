import type { AgentRun, RetrospectiveFeedback, WorkItem } from "../model/kinds.ts";
import type { ResourceDeletionGuard, Validator } from "../ports/index.ts";
import { fingerprint } from "../app/work-item-followups.ts";
import { FEEDBACK_CAPTURE_RECEIPT, feedbackCaptureRevision, RETROSPECTIVE_WORKFLOW } from "./evidence.ts";

export const feedbackDeletionGuard: ResourceDeletionGuard = {
  check(obj) {
    if (obj.kind !== "AgentRun") return;
    const revision = feedbackCaptureRevision(obj as AgentRun);
    if (revision && obj.metadata.annotations?.[FEEDBACK_CAPTURE_RECEIPT] !== revision) {
      return `Feedback capture for ${obj.metadata.name} is pending. Retry deletion after independent evidence is persisted; inspect controller warnings if capture is failing.`;
    }
  },
};

export function retrospectiveValidator(): Validator {
  return {
    name: "retrospective-invariants",
    appliesTo: (kind) => kind === "RetrospectiveFeedback" || kind === "WorkItem",
    async validate(obj, ctx) {
      if (obj.kind === "RetrospectiveFeedback") {
        const f = obj as RetrospectiveFeedback;
        if (obj.metadata.ownerReferences?.length) return ["Feedback must outlive its origin (no cascade owner)"];
        if (!f.spec.origin?.agentRunUid || !f.spec.origin.workItemUid || !f.spec.observation?.observation ||
          !f.spec.target || !f.spec.reporter || !Number.isFinite(Date.parse(f.spec.capturedAt))) return ["Feedback identity, observation and timestamp are required"];
        if (ctx.oldObject) {
          const captured = (x: RetrospectiveFeedback) => {
            const { review: _review, investigationRequest: _request, ...spec } = x.spec;
            return spec;
          };
          if (fingerprint(captured(f)) !== fingerprint(captured(ctx.oldObject as RetrospectiveFeedback))) return ["Captured feedback is immutable"];
        }
        return [];
      }
      const item = obj as WorkItem, old = ctx.oldObject as WorkItem | undefined;
      if (old?.spec.retrospective && fingerprint(old.spec.retrospective) !== fingerprint(item.spec.retrospective)) return ["Retrospective snapshot is immutable"];
      if (item.spec.workflowRef?.name === RETROSPECTIVE_WORKFLOW && !item.spec.retrospective) return ["Start retrospectives from a feedback group"];
      if (!item.spec.retrospective) return [];
      if (item.spec.workflowRef?.name !== RETROSPECTIVE_WORKFLOW || item.spec.sourceRef.name !== "retrospective" ||
        item.spec.repositoryRefs?.length || item.spec.publicationDisabled !== true || item.spec.externalRef || item.metadata.ownerReferences?.length) {
        return ["Retrospectives must remain independent, internal, repository-free and publication-disabled"];
      }
      return [];
    },
  };
}
