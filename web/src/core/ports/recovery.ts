import type { AgentRun, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import type { RecoveryEpisode, RecoveryPolicy, RecoveryReport } from "../model/recovery.ts";

/** Routing is authoritative; a model report is evidence and a recommendation, never authority. */
export interface RecoveryRouter {
  signature(trigger: AgentRun | CheckRun): string;
  route(input: {
    item: WorkItem;
    episode: RecoveryEpisode;
    policy: RecoveryPolicy;
    run: AgentRun;
    report: RecoveryReport;
  }): Promise<RecoveryRoute>;
}

export type RecoveryRoute =
  | { action: "diagnose" | "repair" | "execution-recovery" }
  | { action: "human-need"; need: NonNullable<RecoveryReport["humanNeed"]> }
  | { action: "stop"; reason: string };

/** Revalidates exact caller, assignment, policy and persisted attempt budget immediately before scheduling. */
export interface RecoveryCheckAuthorization {
  authorize(input: { item: WorkItem; origin: CheckWorkflowOrigin; repository: Repository; workspace: Workspace;
    check: string; caller: AgentRun; existing?: CheckRun }): Promise<void>;
}

export interface RecoveryNeedHandler {
  readonly type: string;
  inspect(input: { item: WorkItem; trigger: AgentRun | CheckRun; need: NonNullable<RecoveryReport["humanNeed"]> }): Promise<"needed" | "satisfied" | "invalid">;
  resolve(input: { need: NonNullable<RecoveryReport["humanNeed"]>; answer: string }): "resume" | "stop" | "invalid";
}

export interface RecoveryAllowanceCommands {
  request(p: import("./app.ts").Principal, item: string, input: { requestId: string; count: number; target: "diagnosis" | "repair" | "execution-recovery"; reason: string }): Promise<import("../model/kinds.ts").Approval>;
  decide(p: import("./app.ts").Principal, approval: string, decision: "approve" | "reject", reason: string): Promise<import("../model/kinds.ts").Approval>;
}

export interface RecoveryAllowanceReader {
  approved(item: WorkItem): Promise<{ approval: import("../model/kinds.ts").Approval; staleReason?: string } | undefined>;
}
