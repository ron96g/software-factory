import type { PlanningDecision } from "./planning.ts";

/** The `planning-review` schema version this factory validates (ADR-0057). Earlier versions stay readable only. */
export const PLANNING_REVIEW_SCHEMA_VERSION = "2";

/** Lines of a file in one of the producing run's pinned workspaces. */
export interface CodeLocation {
  repository: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** Exactly one of: a reviewed input artifact at its exact revision, or a code location (ADR-0057). */
export type ReviewEvidence =
  | { artifact: { name: string; resourceVersion: string } }
  | { code: CodeLocation };

interface Finding {
  id: string;
  summary: string;
  evidence: ReviewEvidence[];
}

/** What the reviewer checked before reporting a research gap, and why that did not settle the claim. */
export interface ReviewInvestigation {
  checked: CodeLocation[];
  searches: string[];
  unresolvedBecause: string;
}

export type PlanningReviewFinding = Finding & (
  | { kind: "research-gap"; claim: string; investigation: ReviewInvestigation }
  | { kind: "plan-defect"; requestedChange: string }
  | { kind: "human-decision"; decisionId: string }
  | { kind: "advisory" }
);

/** A claim the reviewer confirmed in code. Shown as checked, never a finding, never blocking. */
export interface VerifiedClaim {
  id: string;
  claim: string;
  evidence: CodeLocation[];
}

export interface PlanningReviewDocument {
  schemaVersion: typeof PLANNING_REVIEW_SCHEMA_VERSION;
  summary: string;
  decisions: PlanningDecision[];
  findings: PlanningReviewFinding[];
  verified?: VerifiedClaim[];
}

export type PlanningReadiness = "working" | "needs-agent-repair" | "needs-answers" | "ready" | "ready-with-findings";

export function planningReviewOutcome(review: PlanningReviewDocument): "approve" | "changes-requested" {
  return review.findings.some((finding) => finding.kind !== "advisory") ? "changes-requested" : "approve";
}
