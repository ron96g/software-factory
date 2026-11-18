import { BARRIER_UNIT, type AgentRun, type CheckWorkflowOrigin, type Repository, type WorkItem, type Workflow } from "../model/kinds.ts";

/** Shared by the scheduler, admission and controller so every path authorizes workflow checks identically. */
export const ORIGIN_KEYS = new Set(["agentRequestId", "agentRunRef", "agentRunUid", "attempt", "planFingerprint", "purpose", "round", "stage", "unit", "unitRun", "recoveryEpisode", "baselineCommit"]);
export const ORIGIN_PURPOSES: CheckWorkflowOrigin["purpose"][] = ["preflight", "preparation", "verification", "unit-readiness", "diagnostic", "baseline"];

const bounded = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;

/** ADR-0067: a baseline submitted by the verification gate itself, with no diagnostic agent caller. */
export const gateBaseline = (origin: CheckWorkflowOrigin) => origin.purpose === "baseline" && !origin.agentRunRef;

export function validCallerName(item: WorkItem, origin: CheckWorkflowOrigin, caller: AgentRun): boolean {
  if (origin.purpose === "diagnostic" || origin.purpose === "baseline") {
    const recovery = caller.spec.recovery;
    return !!recovery && recovery.mode === "diagnosis" && recovery.episode === origin.recoveryEpisode &&
      caller.metadata.name === `${item.metadata.name.slice(0, 130)}-recovery-${recovery.episode}-d${recovery.attempt}`;
  }
  return caller.metadata.name.startsWith(`${item.metadata.name}-${origin.stage}-`) &&
    caller.metadata.name.endsWith(`-r${origin.round}`);
}

/** ADR-0047: Unit identity is required exactly for readiness jobs; a Unit job names its implementation attempt. */
export function validUnitFields(origin: CheckWorkflowOrigin): boolean {
  if (gateBaseline(origin)) return origin.unit === undefined && origin.unitRun === undefined && origin.recoveryEpisode === undefined &&
    origin.agentRequestId === undefined && typeof origin.baselineCommit === "string" && /^[a-f0-9]{40,64}$/.test(origin.baselineCommit);
  if (origin.purpose === "diagnostic" || origin.purpose === "baseline") return bounded(origin.unit, 100) && origin.unit !== BARRIER_UNIT &&
    origin.unitRun === undefined && bounded(origin.recoveryEpisode, 200) && !!origin.agentRunRef && bounded(origin.agentRequestId, 200) &&
    (origin.purpose === "baseline" ? typeof origin.baselineCommit === "string" && /^[a-f0-9]{40,64}$/.test(origin.baselineCommit) : origin.baselineCommit === undefined);
  if (origin.baselineCommit !== undefined) return false;
  if (origin.purpose !== "unit-readiness") return origin.unit === undefined && origin.unitRun === undefined && origin.recoveryEpisode === undefined;
  if (!bounded(origin.unit, 100)) return false;
  if (origin.unit === BARRIER_UNIT) return origin.unitRun === undefined && !origin.agentRunRef && origin.recoveryEpisode === undefined;
  return bounded(origin.unitRun, 253) && (!origin.agentRunRef || origin.agentRunRef.name === origin.unitRun && bounded(origin.agentRequestId, 200)) &&
    (origin.recoveryEpisode === undefined || !!origin.agentRunRef && bounded(origin.recoveryEpisode, 200));
}

/** Stages after `stage` in workflow order. */
function stagesAfter(workflow: Workflow, stage: string): string[] {
  const names = workflow.spec.phases.flatMap((phase) => phase.stages.map((s) => s.name));
  const index = names.indexOf(stage);
  return index < 0 ? [] : names.slice(index + 1);
}

export function originAuthorized(workflow: Workflow | null | undefined, origin: CheckWorkflowOrigin): boolean {
  const policy = workflow?.spec.verification;
  if (!policy) return false;
  switch (origin.purpose) {
    // ADR-0042 §4: prerequisites are rechecked when definitions or the environment change, at entry of any later stage.
    case "preflight": return policy.preflightStage === origin.stage || stagesAfter(workflow!, policy.preflightStage).includes(origin.stage);
    case "preparation": return policy.preparationStage === origin.stage;
    case "verification": return policy.verifyStage === origin.stage;
    case "unit-readiness": {
      const units = workflow?.spec.unitExecution;
      if (!units) return false;
      return origin.unit === BARRIER_UNIT ? units.barrierStage === origin.stage : policy.implementationStage === origin.stage;
    }
    case "diagnostic": return !!workflow?.spec.recovery && !!workflow.spec.unitExecution &&
      policy.implementationStage === origin.stage;
    case "baseline": if (gateBaseline(origin)) return policy.verifyStage === origin.stage;
      return !!workflow?.spec.recovery && !!workflow.spec.unitExecution &&
      policy.implementationStage === origin.stage;
    default: return false;
  }
}

export function originChecks(repository: Repository, origin: CheckWorkflowOrigin, workflow?: Workflow | null): string[] | undefined {
  switch (origin.purpose) {
    case "preflight": return repository.spec.verification?.preflightChecks;
    case "preparation": return repository.spec.verification?.preparationChecks;
    case "unit-readiness": return repository.spec.verification?.readinessChecks;
    case "diagnostic": return workflow?.spec.recovery?.diagnosticChecks
      .filter((name) => name.startsWith(`${repository.metadata.name}/`))
      .map((name) => name.slice(repository.metadata.name.length + 1));
    case "baseline": if (gateBaseline(origin)) return (repository.spec.verification?.autoWaive ?? []).map((entry) => entry.check);
      return workflow?.spec.recovery?.diagnosticChecks
      .filter((name) => name.startsWith(`${repository.metadata.name}/`))
      .map((name) => name.slice(repository.metadata.name.length + 1));
    default: return Object.keys(repository.spec.checks ?? {});
  }
}
