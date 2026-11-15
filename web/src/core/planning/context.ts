import { normalizeQuestions } from "../questions.ts";
import type { AgentRun } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { ContextProvider, Redactor, ResourceReader, WorkflowCompiler } from "../ports/index.ts";
import { currentPlanningRuns, planningIntent } from "./evidence.ts";

export function planningContext(d: { reader: ResourceReader; compiler: WorkflowCompiler; redactor: Redactor }): ContextProvider {
  return {
    name: "planning-intent",
    appliesTo: (ctx) => !!ctx.workItem.spec.workflowRef,
    async provide(ctx) {
      const workflow = await d.compiler.compile(ctx.workItem.spec.workflowRef!, nsOf(ctx.workItem));
      if (!workflow.planning) return [];
      const runs = await d.reader.list<AgentRun>("AgentRun", { namespace: nsOf(ctx.workItem),
        ownedBy: { kind: "WorkItem", name: ctx.workItem.metadata.name, namespace: nsOf(ctx.workItem) } });
      return [{
        title: "Planning contract and human decisions", source: "planning-intent", revision: planningIntent(ctx.workItem),
        content: d.redactor.redact(JSON.stringify({
          instructions: "Research discoverable facts autonomously and consolidate consequential human-only decisions before the first review. During planning, do not stop for confirmation or interview the human. Produce every requested provisional artifact; record genuine human-only uncertainties in questions and in the implementation-plan decision sheet. Never invent high-impact requirements. Optional reversible choices need an explicit recommended default, not a required confirmation question. Required decisions have no implicit answer. Human answers and edits below are authoritative intent, not approval. Preserve decision IDs/questions/options when their semantics are unchanged. Resolve answered questions rather than asking them again or splitting them into further confirmations. Genuinely new consequential uncertainty remains visible and directly answerable on the same sheet, not another automatic interview. Historical batch/discovery fields do not limit human answers or require reopening. Treat every withdrawn answer as historical evidence only, explicitly no longer binding; never use its answer to steer the plan unless the human supplies it again. The planner must carry every upstream question into decisions or explicitly resolve it from supplied evidence/answers; independent review must challenge omissions and repeated settled questions. Do not copy stale draft acceptance language over operator-required checks. Use Mermaid for diagrams, cite researched code, distinguish facts from assumptions. During construction follow the approved implementation plan and any human-approved design; report a necessary design deviation and its reason in your result. Changed scope requires returning to human planning review, never unilateral expansion.",
          humanIntent: ctx.workItem.spec.planning,
          withdrawnAnswers: ctx.workItem.spec.planning?.withdrawn ?? [],
          upstreamQuestions: currentPlanningRuns(ctx.workItem, runs)
            .flatMap((run) => normalizeQuestions(run.status?.result?.questions).map((q) => ({ agent: run.spec.agentRef.name, stage: run.spec.stage, id: q.id, question: q.text, blocker: q.blocker, options: q.options }))),
        }, null, 2)),
      }];
    },
  };
}
