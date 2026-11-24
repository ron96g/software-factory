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
  failureEvidence?(result: ExecResult): { tests: string[] } | undefined;
}

/**
 * ADR-0086 §6: makes a flaky decision visible (once per decision) and turns repeatedly flaky tests into one proposed
 * issue. `check` is `<repository>/<check>`.
 */
export interface FlakyTestReporter {
  report(item: WorkItem, check: string, evidence: import("../model/flaky.ts").FlakyEvidence): Promise<void>;
}

/**
 * ADR-0086: optional, separate from classify (ISP). Every leaf test of a complete run; undefined when the output is not
 * a complete test report. `file` is the failure location as printed (the controller makes it workspace-relative).
 */
export interface TestResultExtractor {
  testResults(result: ExecResult): { failed: { name: string; file?: string }[]; passed: string[]; skipped: number } | undefined;
}

/** ADR-0067: optional, separate from classify (ISP). Returns undefined when output is not comparable. */
export interface FindingExtractor {
  extractFindings(result: ExecResult): import("../model/kinds.ts").CheckFinding[] | undefined;
}

export interface ValidationPlan {
  criteria: { id: string; description: string; checks: string[] }[];
  checks: string[];
  preflight: string[];
  /** ADR-0047: approved Unit manifest, required when the workflow enables unit execution. */
  units?: import("../model/units.ts").PlannedUnit[];
}

export interface ValidationContract {
  artifact: Artifact;
  plan: ValidationPlan;
  fingerprint: string;
  workflowVersions: Record<string, string>;
  repositories: Repository[];
  policy: NonNullable<Workflow["spec"]["verification"]>;
  unitPolicy?: NonNullable<Workflow["spec"]["unitExecution"]>;
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

/**
 * ADR-0054: the route to take when a candidate is not publishable only because it changed after review/verification
 * (e.g. a base merge), a check is still running, or preflight went stale and is rerun in place (ADR-0064); undefined
 * when only a human can help.
 */
export interface PublicationRecovery {
  recover(item: WorkItem): Promise<GateDecision | undefined>;
}

export interface StageEntryPolicy {
  beforeStage(item: WorkItem, stage: CompiledStage): Promise<GateDecision>;
}

/**
 * ADR-0054: a human-approved plan whose binding went stale only because workflow/repository definitions changed is
 * re-confirmed in place (at the current stage) instead of restarting plan review.
 */
export interface PlanReconfirmation {
  /** An await-approval decision when re-confirmation applies; undefined otherwise. */
  request(item: WorkItem, stage: CompiledStage): Promise<GateDecision | undefined>;
  /** Decision for a decided re-confirmation approval: resume the stage, or revise the plan when rejected. */
  decide(item: WorkItem, stage: CompiledStage, approval: Approval): Promise<GateDecision>;
}

export interface StageResumptionPolicy {
  beforeResume(item: WorkItem): Promise<GateDecision>;
}

export interface AgentCheckRequests {
  /** Workspace name or unique repository alias; check name or repository/check identity. */
  run(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }): Promise<CheckRun>;
}

export interface AgentBaselineRequests {
  runBaseline(ctx: ExecutionContext, input: { workspace: string; check: string; requestId: string }): Promise<CheckRun>;
}

export interface AgentCheckLogReader {
  read(ctx: ExecutionContext, input: { checkRun: string; afterSeq?: number; offset?: number }):
    Promise<{ content: string; seq?: number; next: { afterSeq: number; offset: number } | null; logsIncomplete: boolean }>;
}

export interface VerificationActions {
  inspect(p: Principal, item: string): Promise<{ enabled: boolean; workflow?: string; publicationDisabled: boolean; plan?: ValidationPlan; error?: string;
    /** Checks in the plan whose repository has no configured command: they stay NotVerified (policy gaps). */
    gaps?: import("../model/verification-policy.ts").PolicyGap[] }>;
}
