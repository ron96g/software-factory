import type { GateRoute } from "./kinds.ts";

/** Pure mapping of a declarative gate route to a decision (shared by gates and the WorkItem controller). */
export type RouteDecision =
  | { action: "advance" }
  | { action: "goto"; stage: string }
  | { action: "end"; phase: "Done" | "Closed"; reason: string }
  | { action: "block"; questions: string[] };

export function routeToDecision<F>(r: GateRoute | undefined, fallback: F): RouteDecision | F {
  if (!r) return fallback;
  if (r.next) return { action: "goto", stage: r.next };
  if (r.end) return { action: "end", phase: r.end === "Done" ? "Done" : "Closed", reason: r.end };
  if (r.block) return { action: "block", questions: [] };
  return fallback;
}
