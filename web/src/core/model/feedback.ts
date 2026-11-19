import { LABEL_SUPERSEDED, type AgentRun, type InlineFeedback } from "./kinds.ts";

export interface FeedbackDelivery {
  /** The run whose output carries the note; undefined while it still has to reach a run. */
  addressedBy?: string;
}

/**
 * ADR-0071: which notes have reached a run whose effect still counts. Only succeeded, non-replay runs receive notes. If
 * a restart superseded that run, its output (and the change) is gone, so the note is due again, unless a newer
 * submitted note annotates exactly that run's output: then the version attached to the newer note already contains
 * the change.
 */
export function feedbackDelivery(feedback: InlineFeedback[], runs: AgentRun[]): Map<string, FeedbackDelivery> {
  const consumers = new Map<string, AgentRun[]>();
  for (const r of runs) {
    if (r.spec.replayOf || r.status?.phase !== "Succeeded") continue;
    for (const f of r.status.provenance?.feedback ?? []) consumers.set(f, [...(consumers.get(f) ?? []), r]);
  }
  const annotated = new Set(feedback.filter((f) => f.spec.submitted).map((f) => f.spec.producedBy.agentRunRef.name));
  const out = new Map<string, FeedbackDelivery>();
  for (const f of feedback) {
    const by = consumers.get(f.metadata.name) ?? [];
    const effective = by.find((r) => !r.metadata.labels?.[LABEL_SUPERSEDED]) ?? by.find((r) => annotated.has(r.metadata.name));
    out.set(f.metadata.name, { addressedBy: effective?.metadata.name });
  }
  return out;
}

/** Submitted notes that the next run of `run`'s stage/step must receive. */
export function pendingFeedbackFor(run: AgentRun, feedback: InlineFeedback[], runs: AgentRun[]): InlineFeedback[] {
  const delivery = feedbackDelivery(feedback, runs);
  return feedback.filter(
    (f) =>
      !!f.spec.submitted &&
      !delivery.get(f.metadata.name)?.addressedBy &&
      f.spec.producedBy.stage === run.spec.stage &&
      f.spec.producedBy.step === run.spec.step,
  );
}
