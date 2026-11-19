import type { AgentRun, Approval, Artifact, InlineFeedback, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { feedbackDelivery } from "../model/feedback.ts";
import type { CompiledWorkflow, FeedbackPlan, FeedbackView } from "../ports/index.ts";

export function feedbackViews(feedback: InlineFeedback[], runs: AgentRun[], artifacts: Artifact[] = []): FeedbackView[] {
  const delivery = feedbackDelivery(feedback, runs);
  return feedback.map((f) => {
    const by = delivery.get(f.metadata.name)?.addressedBy;
    const outdated = f.spec.submitted ? undefined : outdatedTarget(f, artifacts);
    return { feedback: f, state: !f.spec.submitted ? "draft" : by ? "addressed" : "submitted", addressedBy: by, ...(outdated ? { outdated } : {}) };
  });
}

const current = (a: Artifact) => !a.metadata.labels?.[LABEL_SUPERSEDED] && !a.metadata.labels?.["factory.ai-dlc.io/replay"];

function outdatedTarget(f: InlineFeedback, artifacts: Artifact[]): FeedbackView["outdated"] {
  const target = artifacts.find((a) => a.metadata.name === f.spec.targetRef.name);
  if (!target) return undefined;
  const latest = artifacts.filter((a) => current(a) && a.spec.artifactTypeRef.name === target.spec.artifactTypeRef.name)
    .sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? "") || a.metadata.name.localeCompare(b.metadata.name)).at(-1);
  if (!latest || latest.metadata.name === target.metadata.name) return undefined;
  const quote = comparable(f.spec.quote);
  return { current: latest.metadata.name, quoteFound: !!quote && comparable(readable(latest)).includes(quote) };
}

/** The quote is rendered text: compare letters and digits only, against the string values of JSON artifacts. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function readable(a: Artifact): string {
  if (a.spec.format !== "json") return a.spec.content;
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(a.spec.content)); return strings.join(" "); } catch { return a.spec.content; }
}

/**
 * ADR-0071: an open human gate is rejected when its reject route re-runs the earliest producing stage (or an earlier
 * one); that keeps the human's decision on record. Otherwise the item restarts from the earliest producing stage.
 */
export function planFeedbackSubmission(drafts: InlineFeedback[], wi: WorkItem, wf: CompiledWorkflow, openApproval?: Approval): FeedbackPlan {
  if (!drafts.length) throw new Error("there is no draft feedback to submit");
  const index = (stage: string) => wf.stages.findIndex((s) => s.name === stage);
  const missing = drafts.find((f) => index(f.spec.producedBy.stage) < 0);
  if (missing) throw new Error(`stage "${missing.spec.producedBy.stage}" is no longer part of workflow ${wf.name}`);
  const target = drafts.map((f) => f.spec.producedBy.stage).sort((a, b) => index(a) - index(b))[0];
  const agents = [...new Set(drafts.map((f) => f.spec.producedBy.agentRef.name))];
  const base = { agents, drafts: drafts.length };

  if (wi.status?.phase === "AwaitingApproval" && openApproval && !openApproval.spec.decision && wi.status.blockedBy?.name === openApproval.metadata.name) {
    const next = wf.stage(openApproval.spec.stage)?.gate?.onReject?.next;
    if (next && index(next) >= 0 && index(next) <= index(target)) {
      return { ...base, action: "reject", stage: next, approval: openApproval.metadata.name };
    }
  }
  return { ...base, action: "restart", stage: target };
}
