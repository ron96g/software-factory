/**
 * ADR-0047: sequential execution of approved Units. Small role-specific ports, all implemented by the unit execution
 * service and wired only in the composition root.
 */
import type { AgentRun, UnitAssignment, WorkItem, Workspace } from "../model/kinds.ts";
import type { PlannedUnit } from "../model/units.ts";

export type { PlannedObligation, PlannedUnit } from "../model/units.ts";
import type { Principal } from "./app.ts";
import type { ValidationContract } from "./verification.ts";
import type { CompiledStage, GateDecision } from "./workflow.ts";

/** Chooses what a newly scheduled step is responsible for (e.g. the next ready Unit). */
export interface StepAssignmentPolicy {
  assign(item: WorkItem, stage: CompiledStage, step: number): Promise<UnitAssignment | undefined>;
}

/** Recovers from a failed AgentRun instead of failing the item, when a bounded, safe recovery exists. */
export interface RunFailurePolicy {
  recover(item: WorkItem, stage: CompiledStage, run: AgentRun): Promise<GateDecision | undefined>;
}

/** Pre-review completeness barrier: a hard precondition, never overridable gate evidence. */
export interface CandidateCompleteness {
  /** May schedule barrier readiness checks when `stage` is the barrier stage of the current round. */
  beforeCandidate(item: WorkItem, stage: CompiledStage, contract: ValidationContract): Promise<GateDecision>;
  /** Side-effect free; throws StoreError("Invalid") with the missing scope or evidence. */
  assertComplete(item: WorkItem, contract: ValidationContract): Promise<void>;
}

export interface CandidateState {
  workspaces: Workspace[];
  /** Workspace name → content fingerprint of the current tree. */
  snapshots: Record<string, string>;
  /** Repository name → sandbox profile resourceVersion ("default" when none). */
  profiles: Record<string, string>;
  health: { runtime: string; version?: string; available: boolean; message?: string };
  fingerprint: string;
}

export interface CandidateSnapshots {
  candidate(item: WorkItem, contract: ValidationContract): Promise<CandidateState>;
}

export type UnitState = "pending" | "implementing" | "checking" | "ready" | "blocked";

export interface UnitProgress {
  unit: PlannedUnit;
  state: UnitState;
  /** Latest eligible implementation attempt for this Unit. */
  attempt?: { run: string; outcome?: string; summary?: string };
  checks: { id: string; checkRun?: string; outcome?: string; snapshot?: string }[];
  diagnostics: string[];
}

export interface UnitProgressView {
  enabled: boolean;
  planFingerprint?: string;
  current?: UnitAssignment;
  units: UnitProgress[];
  /** Aggregate pre-review barrier on the current candidate. */
  barrier?: { satisfied: boolean; missing: string[] };
  error?: string;
}

export interface UnitProgressQueries {
  progress(p: Principal, workItem: string): Promise<UnitProgressView>;
}

/** Side-effect free ledger for agent context (no Principal: it serves the factory's own runs). */
export interface UnitLedgerReader {
  view(item: WorkItem): Promise<UnitProgressView>;
}

export interface CompletedUnitAttempt {
  run: string;
  uid: string;
  resourceVersion: string;
  outcome?: string;
  summary?: string;
  result?: { name: string; resourceVersion: string; content: string };
  report?: { name: string; resourceVersion: string; content: string };
  checks: { name: string; resourceVersion: string; check: string; outcome?: string;
    snapshot: string; logRef?: import("./transcripts.ts").TranscriptRef }[];
}

/** Completed, eligible predecessors only; the currently running attempt is never its own history. */
export interface UnitAttemptReader {
  completed(item: WorkItem, assignment: UnitAssignment, currentRun: string): Promise<CompletedUnitAttempt[]>;
}
