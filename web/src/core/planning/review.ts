import type { ApprovalGateEvaluator, GateEvaluator, WorkflowCompiler } from "../ports/index.ts";
import { nsOf } from "../model/meta.ts";

/** Malformed/stale planned evidence needs a revision, not a clarification interview. */
export function planningReview(delegate: GateEvaluator & ApprovalGateEvaluator, compiler: WorkflowCompiler): GateEvaluator & ApprovalGateEvaluator {
  const convert = async (item: Parameters<GateEvaluator["evaluate"]>[0]["workItem"], result: Awaited<ReturnType<GateEvaluator["evaluate"]>>) => {
    if (result.action !== "block" || !item.spec.workflowRef) return result;
    const workflow = await compiler.compile(item.spec.workflowRef, nsOf(item));
    return workflow.planning ? { action: "attention" as const, reason: result.questions.join("\n\n") } : result;
  };
  return {
    type: delegate.type,
    evaluate: async (context) => convert(context.workItem, await delegate.evaluate(context)),
    evaluateApproval: async (context, approval) => convert(context.workItem, await delegate.evaluateApproval(context, approval)),
  };
}
