import type { SandboxProfile } from "../model/kinds.ts";
import { API_VERSION, SYSTEM_NAMESPACE } from "../model/resource.ts";
import { ISOLATION_RANK, type IsolationLevel, type SandboxHealthInfo } from "../ports/index.ts";

/**
 * The profile used when a repository declares none. It accepts weaker isolation (ADR-0080 §11) so a local `bwrap`
 * (`process`) runtime still runs repositories that only declare `container`; a cluster runtime satisfies it anyway.
 */
export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = {
  apiVersion: API_VERSION,
  kind: "SandboxProfile",
  metadata: { name: "default", namespace: SYSTEM_NAMESPACE },
  spec: { image: "", isolation: "container", acceptWeakerIsolation: true },
};

export type DeclaredIsolation = "process" | "container" | "microvm";

export interface IsolationDecision {
  /** The isolation the runtime actually provides. */
  effective: IsolationLevel;
  /** The minimum the profile declares. */
  declared: DeclaredIsolation;
  /** True when the runtime is below the declared minimum and the profile accepts it (ADR-0080 §11). */
  acceptedWeaker: boolean;
}

/**
 * ADR-0080 §11: the isolation requirement lives in the definition, never in an environment variable. A runtime below the
 * profile's declared minimum is refused unless the profile itself sets `spec.acceptWeakerIsolation`. The decision is
 * returned so the caller can record effective-versus-declared isolation (P0-7).
 */
export function decideIsolation(health: SandboxHealthInfo, profile: SandboxProfile): IsolationDecision {
  const declared = (profile.spec.isolation ?? "container") as DeclaredIsolation;
  const acceptedWeaker = ISOLATION_RANK[health.isolation] < ISOLATION_RANK[declared];
  if (acceptedWeaker && !profile.spec.acceptWeakerIsolation) {
    throw new Error(
      `sandbox runtime "${health.runtime}" provides isolation "${health.isolation}", profile "${profile.metadata.name}" requires "${declared}" (ADR-0080 §11: set spec.acceptWeakerIsolation to allow weaker isolation)`,
    );
  }
  return { effective: health.isolation, declared, acceptedWeaker };
}

/** The warning a run records when it runs below the profile's declared minimum. */
export function weakerIsolationNote(health: SandboxHealthInfo, decision: IsolationDecision): string {
  return `WARNING: runtime "${health.runtime}" provides isolation "${decision.effective}"; profile minimum "${decision.declared}" allowed by spec.acceptWeakerIsolation (ADR-0080 §11).`;
}
