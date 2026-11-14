import type { Approval, Artifact, CheckOutcome, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workflow, Workspace } from "../model/kinds.ts";
import type { ExecutionContext } from "./agents.ts";
import type { ExecResult } from "./sandbox.ts";
import type { Principal } from "./app.ts";
import type { CompiledStage, GateDecision } from "./workflow.ts";

export interface CheckRunScheduler {
  submit(request: { workItem: WorkItem; workspace: Workspace; repository: Repository; check: string;
    requestId: string; requestedBy: string; workflow: CheckWorkflowOrigin }): Promise<CheckRun>;
}

export interface CheckResultClassifier {
  readonly format: string;
  classify(result: ExecResult): CheckOutcome;
}

export interface ValidationPlan {
  criteria: { id: string; description: string; checks: string[] }[];
  checks: string[];
  preflight: string[];
}

export interface ValidationContract {
  artifact: Artifact;
  plan: ValidationPlan;
  fingerprint: string;
  workflowVersions: Record<string, string>;
  repositories: Repository[];
  policy: NonNullable<Workflow["spec"]["verification"]>;
}

export interface VerificationContracts {
  plan(item: WorkItem, approved: boolean): Promise<ValidationContract>;
}

export interface VerificationApprovalGuard {
  validate(approval: Approval, decision: "approve" | "reject", comment?: string): Promise<void>;
}

export interface VerificationPublicationGuard {
  check(item: WorkItem): Promise<string | undefined>;
}

export interface StageEntryPolicy {
  beforeStage(item: WorkItem, stage: CompiledStage): Promise<GateDecision>;
}

export interface StageResumptionPolicy {
  beforeResume(item: WorkItem): Promise<GateDecision>;
}

export interface AgentCheckRequests {
  /** Workspace name or unique repository alias; check name or repository/check identity. */
  run(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }): Promise<CheckRun>;
}

export interface VerificationActions {
  inspect(p: Principal, item: string): Promise<{ enabled: boolean; workflow?: string; publicationDisabled: boolean; plan?: ValidationPlan; error?: string }>;
  migrate(p: Principal, item: string, input: { workflow: string; requestId: string }): Promise<WorkItem>;
}
