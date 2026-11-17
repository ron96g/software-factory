/** ADR-0061: pure check-scope policy over Repository definitions (shared by checks and verification). */
import type { CheckRun, CheckWorkflowOrigin, ModuleScopeMode, Repository, VerificationTier } from "./kinds.ts";

/** ADR-0061: tier and default scope per CheckRun purpose. Purposes without an entry use `affected`, without a tier. */
export const TIER_SCOPES: Readonly<Partial<Record<CheckWorkflowOrigin["purpose"], { tier: VerificationTier; scope: ModuleScopeMode }>>> = {
  "unit-readiness": { tier: "readiness", scope: "changed" },
  preparation: { tier: "preparation", scope: "affected" },
  verification: { tier: "verification", scope: "affected" },
};
const TIERS: readonly VerificationTier[] = ["readiness", "preparation", "verification"];
const ORDER: readonly ModuleScopeMode[] = ["changed", "affected", "full"];
export const wider = (a: ModuleScopeMode, b: ModuleScopeMode) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

type CheckValue = NonNullable<Repository["spec"]["checks"]>[string];
const flag = (value: CheckValue | undefined, key: "scoped" | "moduleScoped") => typeof value === "object" && value?.[key] === true;

/** Whether the check takes a module selection (ADR-0044 legacy or ADR-0061 tier-scoped). */
export const isScoped = (repository: Repository, name: string) =>
  flag(repository.spec.checks?.[name], "scoped") || flag(repository.spec.checks?.[name], "moduleScoped");

/** Problems with a repository's `verification.minScope` (ADR-0061); empty when valid. */
export function minScopeProblems(repository: Repository): string[] {
  const minScope = repository.spec.verification?.minScope;
  if (minScope === undefined) return [];
  if (!minScope || typeof minScope !== "object" || Array.isArray(minScope)) return ["verification.minScope must be an object of tiers"];
  const problems: string[] = [];
  for (const [tier, checks] of Object.entries(minScope)) {
    if (!TIERS.includes(tier as VerificationTier)) { problems.push(`verification.minScope: unknown tier "${tier}"`); continue; }
    if (!checks || typeof checks !== "object" || Array.isArray(checks)) { problems.push(`verification.minScope.${tier} must map checks to a scope`); continue; }
    for (const [check, scope] of Object.entries(checks)) {
      const value = repository.spec.checks?.[check];
      if (scope !== "affected" && scope !== "full") problems.push(`verification.minScope.${tier}.${check} must be "affected" or "full"`);
      else if (value === undefined) problems.push(`verification.minScope.${tier}.${check}: check is not configured`);
      else if (flag(value, "moduleScoped")) problems.push(`verification.minScope.${tier}.${check}: legacy moduleScoped checks always run affected; declare scoped: true`);
      else if (!flag(value, "scoped")) problems.push(`verification.minScope.${tier}.${check}: only scoped checks have a scope`);
    }
  }
  return problems;
}


/** The scope a check runs with for a CheckRun purpose: legacy `affected`, else the tier default raised by `minScope` (assumes a valid policy). */
export function requestedScope(repository: Repository, name: string, purpose?: CheckWorkflowOrigin["purpose"]): ModuleScopeMode {
  if (flag(repository.spec.checks?.[name], "moduleScoped")) return "affected";
  const tier = purpose ? TIER_SCOPES[purpose] : undefined;
  if (!tier) return "affected";
  const raised = repository.spec.verification?.minScope?.[tier.tier]?.[name];
  return raised ? wider(raised, tier.scope) : tier.scope;
}


/**
 * ADR-0061 evidence rule: a CheckRun counts as evidence for a purpose only if it ran for exactly that purpose (stricter
 * than "same or higher tier") and covered at least the scope that purpose requires for the check.
 */
export function scopeSatisfies(repository: Repository, check: string, run: Pick<CheckRun, "spec">, purpose: CheckWorkflowOrigin["purpose"]): boolean {
  if (run.spec.workflow?.purpose !== purpose) return false;
  if (!isScoped(repository, check)) return run.spec.scope === undefined;
  const mode = run.spec.scope?.mode;
  return !!mode && wider(mode, requestedScope(repository, check, purpose)) === mode;
}
