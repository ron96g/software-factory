import type { Approval, RetrospectiveFeedback, RetrospectiveFeedbackSpec, RetrospectivePolicy, WorkItem } from "../model/kinds.ts";
import type { AgentResult, ExecutionContext } from "./agents.ts";
import type { Principal } from "./app.ts";

export interface FeedbackCapture {
  prepare(ctx: ExecutionContext, result: AgentResult): { candidates: RetrospectiveFeedbackSpec[]; warnings: string[] };
}

export interface RetrospectiveGroup {
  id: string;
  revision: string;
  policy: RetrospectivePolicy;
  target: RetrospectiveFeedbackSpec["target"];
  issueCode: string;
  reports: { feedback: RetrospectiveFeedback; eligible: boolean; exclusions: string[]; originAvailable: boolean }[];
  origins: number;
  roles: string[];
  thresholdMet: boolean;
  investigations: WorkItem[];
}

export interface RetrospectiveAggregation {
  groups(namespace: string): Promise<RetrospectiveGroup[]>;
}

export interface RetrospectiveQueries {
  list(p: Principal): Promise<RetrospectiveGroup[]>;
}

export interface RetrospectiveCommands {
  investigate(p: Principal, group: string, input: { revision: string; requestId: string }): Promise<void>;
  disposition(p: Principal, name: string, input: { version: string; disposition: "open" | "dismissed"; issueCode?: string; comment: string }): Promise<void>;
  recordOutcome(p: Principal, name: string, input: {
    version: string; disposition: "open" | "deferred" | "closed";
    implementation?: string; loadedVersion?: string; benefit?: string;
  }): Promise<void>;
}

/** Additional human-decision checks, registered in the composition root. */
export interface ApprovalDecisionGuard {
  validate(approval: Approval, decision: "approve" | "reject"): Promise<void>;
}

export interface RetrospectiveInvestigator {
  reconcile(namespace: string): Promise<void>;
}
