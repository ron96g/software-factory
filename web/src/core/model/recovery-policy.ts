import type { WorkflowSpec } from "./kinds.ts";

/** Validate untrusted definitions before compilation or admission; no implicit enablement. */
export function recoveryPolicyProblems(spec: WorkflowSpec): string[] {
  const raw: unknown = spec.recovery;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["spec.recovery must be an object"];
  const p = raw as Record<string, unknown>;
  const errors: string[] = [];
  const keys = new Set(["version", "maxDiagnosisAttempts", "maxTotalAttempts", "humanNeedReserve", "maxOperatorAllowance", "diagnosticChecks"]);
  for (const key of Object.keys(p)) if (!keys.has(key)) errors.push(`spec.recovery.${key} is not allowed`);
  if (typeof p.version !== "string" || !p.version.trim() || p.version.length > 100) errors.push("spec.recovery.version must be a non-empty version");
  const integer = (key: string, min: number, max: number, optional = false) => {
    const n = p[key];
    if (n === undefined && optional) return;
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) errors.push(`spec.recovery.${key} must be an integer from ${min} to ${max}`);
  };
  integer("maxDiagnosisAttempts", 1, 10, true);
  integer("maxTotalAttempts", 1, 100);
  integer("humanNeedReserve", 0, 1);
  integer("maxOperatorAllowance", 0, 100);
  if (typeof p.maxTotalAttempts === "number" && typeof p.humanNeedReserve === "number" && p.maxTotalAttempts <= p.humanNeedReserve) {
    errors.push("spec.recovery.maxTotalAttempts must exceed the human-need reserve");
  }
  if (!Array.isArray(p.diagnosticChecks) || p.diagnosticChecks.some((x) => typeof x !== "string" || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(x)) ||
      new Set(p.diagnosticChecks).size !== p.diagnosticChecks.length) {
    errors.push("spec.recovery.diagnosticChecks must contain unique repository/check names");
  }
  if (!spec.verification || !spec.unitExecution) errors.push("spec.recovery requires verification and unitExecution");
  return errors;
}
