import type { EventRecorder, GateCheckLookup, GateDecision, GateEvaluator } from "../ports/index.ts";
import { routeToDecision } from "../model/routes.ts";

/** Routes on the outcome of the stage's last agent run (`status.lastOutcome`). */
export const decisionGate: GateEvaluator = {
  type: "decision",
  async evaluate({ workItem, gate }) {
    const outcome = workItem.status?.lastOutcome;
    if (!outcome) return { action: "fail", reason: "decision gate: the stage produced no outcome" };
    const route = gate.routes?.[outcome];
    if (!route) return { action: "fail", reason: `decision gate: no route for outcome "${outcome}"` };
    return routeToDecision(route, { action: "advance" });
  },
};

/** Human approval: always suspends via an Approval resource (ADR-0005). */
export const humanApprovalGate: GateEvaluator = {
  type: "human-approval",
  async evaluate() {
    return { action: "await-approval" };
  },
};

/** Runs registered checks. MVP: unknown checks pass with a warning event (AGENTS.md §4). */
export function automatedGate(checks: GateCheckLookup, events: EventRecorder): GateEvaluator {
  return {
    type: "automated",
    async evaluate(ctx) {
      for (const name of ctx.gate.checks ?? []) {
        const check = checks.get(name);
        if (!check) {
          await events.warning(ctx.workItem, "CheckNotImplemented", `automated check "${name}" is not implemented; passing (MVP)`);
          continue;
        }
        const r = await check.run(ctx);
        if (!r.passed) {
          const retry = (ctx.gate.onFailure as { retry?: { next?: string } } | undefined)?.retry?.next;
          return retry ? { action: "goto", stage: retry } : { action: "fail", reason: `check ${name} failed: ${r.message ?? ""}` };
        }
      }
      return { action: "advance" };
    },
  };
}

