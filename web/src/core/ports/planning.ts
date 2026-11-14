import type { WorkItem } from "../model/kinds.ts";
import type { Principal } from "./app.ts";
import type { CompiledStage, GateDecision } from "./workflow.ts";
import type { PlanningDecision, PlanningDocument, PlanningSections } from "../model/planning.ts";
export type { PlanningDecision, PlanningDocument, PlanningSections } from "../model/planning.ts";

export interface PlanningWorkspace {
  enabled: boolean;
  revision: string;
  document?: PlanningDocument;
  previous?: PlanningDocument;
  historyError?: string;
  draft?: PlanningSections;
  decisions: (PlanningDecision & { answer?: string })[];
  unansweredQuestions: string[];
  /** Historical submission state, never permission to answer the current decisions. */
  batchSubmitted: boolean;
  ready: boolean;
  issues: string[];
  approval?: string;
  canRevise: boolean;
  disposition?: "rejected" | "deferred";
  /** The independent AI review requested changes: approving needs an explicit human reason (the human decides). */
  reviewFindings?: boolean;
}

export interface PlanningQueries {
  inspect(p: Principal, item: string): Promise<PlanningWorkspace>;
}

export interface PlanningRevisionInput {
  revision: string;
  requestId: string;
  /** `reopen` remains accepted for original clients; submitting answers never requires it. */
  action: "revise" | "decisions" | "reopen" | "reject" | "defer";
  context?: string;
  draft?: PlanningSections;
  feedback?: string;
  answers?: Record<string, string>;
}

export interface PlanningCommands {
  revise(p: Principal, item: string, input: PlanningRevisionInput): Promise<WorkItem>;
}

/** Additional exact-revision evidence bound by verified plan reviews. */
export interface PlanningReviewBinding {
  binding(item: WorkItem): Promise<string | undefined>;
  assertReady(item: WorkItem): Promise<void>;
}

/** Whether the independent AI plan review still requests changes; advisory to the human, never a veto. */
export interface PlanningReviewOutcome {
  requestsChanges(item: WorkItem): Promise<boolean>;
}

export interface AgentQuestionPolicy {
  deferQuestions(item: WorkItem, stage: CompiledStage): Promise<boolean>;
}

/** Human-owned terminal intent is applied only by the WorkItem controller. */
export interface WorkItemIntentPolicy {
  intent(item: WorkItem): Promise<Extract<GateDecision, { action: "end" }> | undefined>;
}
