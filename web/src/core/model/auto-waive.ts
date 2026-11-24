/** ADR-0067: pure validation of Repository.verification.autoWaive; empty when valid. */
import type { Repository } from "./kinds.ts";

export function autoWaiveProblems(repository: Repository): string[] {
  const entries = repository.spec.verification?.autoWaive;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return ["verification.autoWaive must be a list"];
  const waivable = repository.spec.verification?.waivableChecks ?? [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.check !== "string") { problems.push("verification.autoWaive entries need a check"); continue; }
    if (entry.when !== "pre-existing" && entry.when !== "flaky") problems.push(`verification.autoWaive.${entry.check}: when must be "pre-existing" or "flaky"`);
    if (entry.followUp !== undefined && entry.followUp !== "finding") problems.push(`verification.autoWaive.${entry.check}: followUp must be "finding"`);
    if (!waivable.includes(entry.check)) problems.push(`verification.autoWaive.${entry.check}: check must be in waivableChecks`);
  }
  return problems;
}
