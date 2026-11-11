import type { GateEvaluator } from "../ports/index.ts";
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

