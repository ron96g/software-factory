import { BARRIER_UNIT, type CheckWorkflowOrigin, type Repository, type Workflow } from "../model/kinds.ts";

/** Shared by the scheduler, admission and controller so every path authorizes workflow checks identically. */
export const ORIGIN_KEYS = new Set(["agentRequestId", "agentRunRef", "agentRunUid", "attempt", "planFingerprint", "purpose", "round", "stage", "unit", "unitRun"]);
export const ORIGIN_PURPOSES: CheckWorkflowOrigin["purpose"][] = ["preflight", "preparation", "verification", "unit-readiness"];

const bounded = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;

/** ADR-0047: Unit identity is required exactly for readiness jobs; a Unit job names its implementation attempt. */
export function validUnitFields(origin: CheckWorkflowOrigin): boolean {
  if (origin.purpose !== "unit-readiness") return origin.unit === undefined && origin.unitRun === undefined;
  if (origin.agentRunRef !== undefined || !bounded(origin.unit, 100)) return false;
  return origin.unit === BARRIER_UNIT ? origin.unitRun === undefined : bounded(origin.unitRun, 253);
}

export function originAuthorized(workflow: Workflow | null | undefined, origin: CheckWorkflowOrigin): boolean {
  const policy = workflow?.spec.verification;
  if (!policy) return false;
  switch (origin.purpose) {
    case "preflight": return policy.preflightStage === origin.stage;
    case "preparation": return policy.preparationStage === origin.stage;
    case "verification": return policy.verifyStage === origin.stage;
    case "unit-readiness": {
      const units = workflow?.spec.unitExecution;
      if (!units) return false;
      return origin.unit === BARRIER_UNIT ? units.barrierStage === origin.stage : policy.implementationStage === origin.stage;
    }
    default: return false;
  }
}

export function originChecks(repository: Repository, origin: CheckWorkflowOrigin): string[] | undefined {
  switch (origin.purpose) {
    case "preflight": return repository.spec.verification?.preflightChecks;
    case "preparation": return repository.spec.verification?.preparationChecks;
    case "unit-readiness": return repository.spec.verification?.readinessChecks;
    default: return Object.keys(repository.spec.checks ?? {});
  }
}
