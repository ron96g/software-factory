import { nsOf } from "../model/meta.ts";
import type { ContextProvider, Redactor, UnitAttemptReader, UnitLedgerReader, WorkflowCompiler } from "../ports/index.ts";

const RESULT_FORMAT = {
  unit: "U1",
  outcome: "complete | partial | blocked",
  obligations: [{ id: "U1-O1", status: "done | partial | blocked", evidence: [{ path: "repository-relative/file.ts", detail: "what this file proves" }] }],
  remaining: "Markdown: anything not finished and why (required unless complete)",
};

/** ADR-0047: the assigned Unit for implementers; the whole-plan ledger for reviewers and the verifier. */
export function unitContext(d: { ledger: UnitLedgerReader; compiler: WorkflowCompiler; redactor: Redactor; attempts?: UnitAttemptReader }): ContextProvider {
  return {
    name: "unit-execution",
    appliesTo: (ctx) => !!ctx.workItem.spec.workflowRef,
    async provide(ctx) {
      const workflow = await d.compiler.compile(ctx.workItem.spec.workflowRef!, nsOf(ctx.workItem));
      if (!workflow.unitExecution || !workflow.verification) return [];
      const names = workflow.stages.map((s) => s.name);
      const assignment = ctx.run.spec.assignment;
      if (!assignment && names.indexOf(ctx.run.spec.stage) <= names.indexOf(workflow.verification.implementationStage)) return [];
      const view = await d.ledger.view(ctx.workItem);
      const ledger = view.units.map((u) => ({ id: u.unit.id, title: u.unit.title, state: u.state, dependsOn: u.unit.dependsOn,
        criteria: u.unit.criteria, obligations: u.unit.obligations, lastAttempt: u.attempt, readinessChecks: u.checks, diagnostics: u.diagnostics }));
      if (view.error) return [{ title: "Unit execution contract", source: "unit-execution", content: d.redactor.redact(`Unavailable: ${view.error}`) }];
      const completed = assignment && d.attempts ? await d.attempts.completed(ctx.workItem, assignment, ctx.run.metadata.name) : [];
      const history = completed.slice(-3).map((attempt) => ({
        ...attempt, summary: attempt.summary?.slice(0, 2400),
        result: attempt.result && { ...attempt.result, content: attempt.result.content.slice(0, 2400) },
        report: attempt.report && { ...attempt.report, content: attempt.report.content.slice(0, 4800) },
      }));
      const progress = {
        currentAttempt: { run: ctx.run.metadata.name }, previousAttempt: history.at(-1) ?? null,
        attemptHistory: history, omittedAttemptRuns: completed.slice(0, -3).map((attempt) => attempt.run),
      };
      if (ctx.run.spec.recovery?.mode === "diagnosis") {
        return [{
          title: "Unit recovery evidence", source: "unit-execution", revision: assignment?.planFingerprint,
          content: d.redactor.redact(JSON.stringify({
            instructions: "Diagnose the retained failure. Do not implement, edit the candidate, or claim Unit completion in this diagnostic run. " +
              "Follow the recovery-report contract. Prior attempts and readiness evidence below are history, not proof of a current pass.",
            ...progress, ledger,
          }, null, 2)),
        }];
      }
      if (assignment?.kind === "unit") {
        const unit = view.units.find((u) => u.unit.id === assignment.unit);
        return [{
          title: `Your assignment: Unit ${assignment.unit}`, source: "unit-execution", revision: assignment.planFingerprint,
          content: d.redactor.redact(JSON.stringify({
            instructions: `Implement Unit ${assignment.unit} completely: every obligation below, with tests, in the current workspace. ` +
              "Other Units are context: build on Units already ready, do not start later Units and do not undo completed work. " +
              "Do not stop after a slice: keep working until every obligation is done, or report honestly why it cannot be. " +
              `Finish with outcome "complete" only when every obligation is done; otherwise "partial" or "blocked" plus questions for genuine human-only blockers. ` +
              `Also return a "unit-result" artifact containing only JSON in resultFormat. Evidence paths must exist in the workspace. ` +
              "The factory then runs the obligations' named readiness checks; a failed check or a missing obligation sends this Unit back to you, and review starts only after every Unit is ready.",
            assignment: unit?.unit, ...progress,
            previousDiagnostics: unit?.diagnostics, resultFormat: RESULT_FORMAT, ledger,
          }, null, 2)),
        }];
      }
      if (assignment?.kind === "repair") {
        return [{
          title: "Your assignment: cross-Unit repair", source: "unit-execution", revision: assignment.planFingerprint,
          content: d.redactor.redact(JSON.stringify({
            instructions: "Every approved Unit is ready. Your job is to change code so the open findings among your inputs are resolved: " +
              "first the blocking findings of the latest code-review-report, then failing checks and human gate feedback. " +
              "Re-running checks or re-reading files without editing code is not a repair. Work through the findings one by one, " +
              "test-first, without removing delivered obligations. A finding that needs a human decision becomes a question; do not " +
              "guess and do not skip the rest. The factory re-runs every readiness check itself afterwards; after this attempt the " +
              "candidate goes to code review with whatever is still open, so do as much as you can now. " +
              `Finish with outcome "complete" when every finding is addressed, otherwise "partial" and list exactly which remain and why.`,
            ...progress, ledger,
          }, null, 2)),
        }];
      }
      return [{
        title: "Approved Units and readiness evidence", source: "unit-execution", revision: view.planFingerprint,
        content: d.redactor.redact(JSON.stringify({
          instructions: "Review the whole candidate against every approved Unit and acceptance criterion, not only the latest change. " +
            "Readiness checks are construction evidence, not final verification; missing behavior is a blocking finding even when checks pass.",
          ledger, barrier: view.barrier,
        }, null, 2)),
      }];
    },
  };
}
