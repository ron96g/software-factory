import type { RetrospectiveFeedbackSpec, RetrospectiveObservation } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import type { AgentResult, Clock, ExecutionContext, FeedbackCapture, Redactor } from "../ports/index.ts";

function observation(value: unknown): value is RetrospectiveObservation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["stage", "issueCode", "observation", "impact", "suggestion", "evidence"].every((k) => typeof v[k] === "string" && !!v[k].trim()) &&
    ["support", "positive", "counterevidence"].includes(String(v.stance));
}

export class DefaultFeedbackCapture implements FeedbackCapture {
  private readonly redactor: Redactor;
  private readonly clock: Clock;
  constructor(redactor: Redactor, clock: Clock) { this.redactor = redactor; this.clock = clock; }

  prepare(ctx: ExecutionContext, result: AgentResult) {
    const candidates: RetrospectiveFeedbackSpec[] = [], warnings: string[] = [];
    if (result.feedback === undefined) return { candidates, warnings };
    if (!ctx.agent.spec.retrospectiveFeedback || ctx.workItem.spec.retrospective) {
      return { candidates, warnings: ["Feedback ignored: agent not opted in or run belongs to a retrospective."] };
    }
    if (!Array.isArray(result.feedback)) return { candidates, warnings: ["Feedback must be an array."] };
    if (result.feedback.length > 3) warnings.push("Feedback truncated to three observations.");
    const workflow = ctx.run.spec.workflow;
    for (const [index, raw] of result.feedback.slice(0, 3).entries()) {
      if (!observation(raw) || raw.stage !== ctx.run.spec.stage || !/^[a-z][a-z0-9-]{0,79}$/.test(raw.issueCode)) {
        warnings.push(`Feedback ${index}: malformed observation, issue code, or stage not executed by this run.`);
        continue;
      }
      let truncated = false;
      const text = (value: string) => {
        const clean = this.redactor.redact(value.trim());
        truncated ||= clean.length > 1500;
        return clean.slice(0, 1500);
      };
      const verified = !!workflow && workflow.stage === ctx.run.spec.stage && !!workflow.target.version &&
        Object.keys(workflow.versions).length > 0 &&
        Object.entries(workflow.versions).every(([key, version]) => !!version && ctx.workflowVersions?.[key] === version) &&
        Object.keys(workflow.versions).length === Object.keys(ctx.workflowVersions ?? {}).length;
      candidates.push({
        observation: { stage: raw.stage, issueCode: raw.issueCode, stance: raw.stance, observation: text(raw.observation),
          impact: text(raw.impact), suggestion: text(raw.suggestion), evidence: text(raw.evidence) },
        target: { namespace: workflow?.target.namespace ?? "", name: workflow?.target.name ?? ctx.workItem.spec.workflowRef?.name ?? "",
          version: workflow?.target.version ?? "", stage: ctx.run.spec.stage, workflowVersions: workflow?.versions ?? {} },
        reporter: { agent: ctx.agent.metadata.name, role: ctx.agent.spec.role, kind: "agent" },
        origin: { workItem: ctx.workItem.metadata.name, workItemUid: ctx.workItem.metadata.uid ?? "",
          agentRun: ctx.run.metadata.name, agentRunUid: ctx.run.metadata.uid ?? "" },
        capturedAt: this.clock.now().toISOString(),
        executor: result.provenance?.executor ?? (ctx.model ? "llm" : "unknown"),
        verified: verified && !!ctx.workItem.metadata.uid && !!ctx.run.metadata.uid,
        replay: !!ctx.run.spec.replayOf,
        superseded: !!ctx.run.metadata.labels?.[LABEL_SUPERSEDED],
        truncated,
      });
    }
    return { candidates, warnings };
  }
}
