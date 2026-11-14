import type { AgentRun, RetrospectiveFeedback, RetrospectivePolicy, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { fingerprint } from "../app/work-item-followups.ts";

export const RETROSPECTIVE_WORKFLOW = "factory-retrospective";
export const FEEDBACK_CAPTURE_RECEIPT = "factory.ai-dlc.io/feedback-captured";
export const hasControllerFeedback = (run: AgentRun) => run.status?.phase === "Failed" && !!run.spec.workflow &&
  !Object.keys(run.spec.workflow.versions).some((key) => key.endsWith(`/${RETROSPECTIVE_WORKFLOW}`));

export function feedbackCaptureRevision(run: AgentRun): string | undefined {
  if (!run.status?.feedbackCandidates?.length && !run.status?.feedbackWarnings?.length && !hasControllerFeedback(run)) return undefined;
  return fingerprint([run.metadata.uid, run.status?.feedbackCandidates, run.status?.feedbackWarnings,
    hasControllerFeedback(run) ? [run.spec.workflow, run.status?.message, run.status?.finishedAt] : null]);
}
export const DEFAULT_RETROSPECTIVE_POLICY: RetrospectivePolicy = {
  version: "1",
  issueCodes: ["missing-repository-context", "missing-ticket-history", "unavailable-tool", "ineffective-step"],
  minimumOrigins: 3, minimumRoles: 2, windowDays: 14,
};

export function feedbackIdentity(f: RetrospectiveFeedback) {
  const { review, investigationRequest: _request, ...captured } = f.spec;
  return fingerprint([f.metadata.uid, captured, review]);
}

export function groupId(f: RetrospectiveFeedback) {
  const target = f.spec.target;
  return fingerprint([nsOf(f), target.namespace, target.name, target.version, target.stage,
    Object.entries(target.workflowVersions).sort(([a], [b]) => a.localeCompare(b)), f.spec.review?.issueCode ?? f.spec.observation.issueCode]).slice(0, 32);
}

export function exclusions(f: RetrospectiveFeedback, policy: RetrospectivePolicy, run: AgentRun | undefined, item: WorkItem | undefined, now: number, includeWindow = true) {
  const s = f.spec, reasons: string[] = [];
  if (!s.verified) reasons.push("Unverified workflow provenance");
  if (!policy.issueCodes.includes(s.review?.issueCode ?? s.observation.issueCode)) reasons.push("Unknown issue code");
  if (s.reporter.kind !== "agent") reasons.push("Controller observation");
  if (s.observation.stance !== "support") reasons.push(s.observation.stance);
  if (s.replay || run?.spec.replayOf) reasons.push("Replay");
  if (s.superseded || run?.metadata.labels?.[LABEL_SUPERSEDED]) reasons.push("Superseded");
  if (!["llm", "tool-loop"].includes(s.executor)) reasons.push("Simulated or non-model execution");
  if (s.review?.disposition === "dismissed") reasons.push("Dismissed by human");
  if (Object.keys(s.target.workflowVersions).some((key) => key.endsWith(`/${RETROSPECTIVE_WORKFLOW}`)) || item?.spec.retrospective) reasons.push("Retrospective run");
  if (!run || run.metadata.uid !== s.origin.agentRunUid || !item || item.metadata.uid !== s.origin.workItemUid) reasons.push("Origin missing or replaced");
  if (includeWindow && (Date.parse(s.capturedAt) > now || Date.parse(s.capturedAt) < now - policy.windowDays * 86_400_000)) reasons.push("Outside support window");
  return reasons;
}

export function support(reports: { feedback: RetrospectiveFeedback; eligible: boolean }[]) {
  const eligible = reports.filter((r) => r.eligible);
  return {
    origins: new Set(eligible.map((r) => r.feedback.spec.origin.workItemUid)).size,
    roles: [...new Set(eligible.map((r) => r.feedback.spec.reporter.role))].sort(),
  };
}
