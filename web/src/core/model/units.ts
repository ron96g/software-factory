import { BARRIER_UNIT, type Repository } from "./kinds.ts";

export interface PlannedObligation {
  id: string;
  description: string;
  /** Approved `repository/check` identities that must pass for this obligation (construction readiness only). */
  checks: string[];
}

/** ADR-0047: one approved Unit of the validation plan's manifest. */
export interface PlannedUnit {
  id: string;
  title: string;
  dependsOn: string[];
  /** Acceptance-criterion IDs of the validation plan this Unit delivers. */
  criteria: string[];
  obligations: PlannedObligation[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const text = (value: unknown) => typeof value === "string" && !!value.trim();
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string" && !!v.trim());

/**
 * Pure validation of the approved Unit manifest. Deterministic gaps — unknown references, cycles, empty obligations,
 * unmapped criteria and checks outside the readiness allowlist — make the plan invalid instead of being inferred.
 */
export function parseUnitManifest(raw: unknown, plan: { criteria: { id: string }[]; checks: string[] }, repositories: Repository[]):
  { units: PlannedUnit[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "the approved validation-plan has no units[] manifest, which unit execution requires; restart from validation planning (or spec) for a fresh plan with Units and approve it" };
  const units: PlannedUnit[] = [];
  const obligationIds = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") return { error: "each Unit must be an object" };
    const u = value as Record<string, unknown>;
    if (typeof u.id !== "string" || !ID.test(u.id) || u.id === BARRIER_UNIT) return { error: `Unit ID ${JSON.stringify(u.id)} must be a short stable identifier` };
    if (units.some((x) => x.id === u.id)) return { error: `duplicate Unit ID ${u.id}` };
    if (!text(u.title)) return { error: `Unit ${u.id} needs a title` };
    const dependsOn = u.dependsOn === undefined ? [] : u.dependsOn;
    // Infrastructure/cross-cutting Units may deliver no criterion directly; every criterion still needs a Unit below.
    if (!ids(dependsOn) || !ids(u.criteria)) return { error: `Unit ${u.id} needs dependsOn[] and criteria[]` };
    if (!Array.isArray(u.obligations) || !u.obligations.length) return { error: `Unit ${u.id} needs at least one completion obligation` };
    const obligations: PlannedObligation[] = [];
    for (const o of u.obligations as Record<string, unknown>[]) {
      if (!o || typeof o.id !== "string" || !ID.test(o.id) || !text(o.description) || !ids(o.checks) || !o.checks.length) {
        return { error: `Unit ${u.id}: each obligation needs an id, description and readiness checks[]` };
      }
      if (obligationIds.has(o.id)) return { error: `duplicate obligation ID ${o.id}` };
      obligationIds.add(o.id);
      for (const id of o.checks) {
        const [repository, check, extra] = id.split("/");
        const repo = repositories.find((r) => r.metadata.name === repository);
        if (!repo || !check || extra || !plan.checks.includes(id) || !repo.spec.checks?.[check] ||
            !repo.spec.verification?.readinessChecks?.includes(check)) {
          return { error: `obligation ${o.id}: ${id} is not a configured readiness check in the reviewed plan` };
        }
      }
      obligations.push({ id: o.id, description: String(o.description), checks: [...new Set(o.checks)] });
    }
    const unknown = u.criteria.find((criterion) => !plan.criteria.some((c) => c.id === criterion));
    if (unknown) return { error: `Unit ${u.id} references unknown criterion ${unknown}` };
    units.push({ id: u.id, title: String(u.title), dependsOn: [...new Set(dependsOn)], criteria: [...new Set(u.criteria)], obligations });
  }
  for (const unit of units) {
    const bad = unit.dependsOn.find((dep) => dep === unit.id || !units.some((u) => u.id === dep));
    if (bad) return { error: `Unit ${unit.id} has unknown or self dependency ${bad}` };
  }
  const state = new Map<string, "visiting" | "done">();
  const cycle = (id: string, path: string[]): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...path, id];
    state.set(id, "visiting");
    for (const dep of units.find((u) => u.id === id)!.dependsOn) {
      const found = cycle(dep, [...path, id]);
      if (found) return found;
    }
    state.set(id, "done");
    return undefined;
  };
  for (const unit of units) {
    const found = cycle(unit.id, []);
    if (found) return { error: `Unit dependency cycle: ${found.join(" → ")}` };
  }
  const unmapped = plan.criteria.filter((c) => !units.some((u) => u.criteria.includes(c.id))).map((c) => c.id);
  if (unmapped.length) return { error: `acceptance criteria without a delivering Unit: ${unmapped.join(", ")}` };
  return { units };
}

/** First Unit in approved order whose dependencies are all ready (always exists for an acyclic, incomplete manifest). */
export function nextUnit(units: PlannedUnit[], ready: Set<string>): PlannedUnit | undefined {
  return units.find((u) => !ready.has(u.id) && u.dependsOn.every((dep) => ready.has(dep)));
}

export const unitChecks = (unit: PlannedUnit) => [...new Set(unit.obligations.flatMap((o) => o.checks))];
export const allUnitChecks = (units: PlannedUnit[]) => [...new Set(units.flatMap(unitChecks))];
