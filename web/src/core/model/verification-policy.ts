import type { Repository } from "./kinds.ts";

/** A named check that repository policy relies on but that has no configured command, so it can never pass. */
export interface PolicyGap {
  repository: string;
  check: string;
  role: "required" | "preflight" | "preparation" | "readiness";
  /** Only waivable required checks can be completed at all (as Waived, never Passed). */
  waivable: boolean;
}

/** Pure and deterministic, so the validator, system health and plan review report the same gaps. */
export function verificationPolicyGaps(repository: Repository): PolicyGap[] {
  const policy = repository.spec.verification;
  if (!policy) return [];
  const configured = (check: string) => !!repository.spec.checks?.[check];
  const gaps: PolicyGap[] = [];
  const add = (role: PolicyGap["role"], checks: string[] | undefined) => {
    for (const check of checks ?? []) {
      if (!configured(check)) gaps.push({ repository: repository.metadata.name, check, role,
        waivable: role === "required" && !!policy.waivableChecks?.includes(check) });
    }
  };
  add("required", policy.requiredChecks);
  add("preflight", policy.preflightChecks);
  add("preparation", policy.preparationChecks);
  add("readiness", policy.readinessChecks);
  return gaps;
}

export const gapId = (gap: PolicyGap) => `${gap.repository}/${gap.check}`;
