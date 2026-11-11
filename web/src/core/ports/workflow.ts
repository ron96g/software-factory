/**
 * Workflow ports: compile declarative Workflows into a flat stage list and evaluate gates.
 * Gate types and automated checks are extension points (Strategy + Registry).
 */
import type { Ref } from "../model/resource.ts";
import type { GateSpec, StageSpec, StepSpec, WorkItem } from "../model/kinds.ts";

export interface CompiledStage {
  name: string;
  publish?: StageSpec["publish"];
  loop?: StageSpec["loop"];
  /** AI-DLC phase (inception / construction / operations). */
  lifecyclePhase: string;
  /** Workflow that declared the stage (sub-workflows are inlined). */
  origin: string;
  mode?: string;
  steps: StepSpec[];
  gate?: GateSpec;
}

export interface CompiledWorkflow {
  name: string;
  stages: CompiledStage[];
  stage(name: string): CompiledStage | undefined;
  /** Stage after `name`, or undefined at the end. */
  next(name: string): CompiledStage | undefined;
}

export interface WorkflowCompiler {
  /** Resolves `ref` from `namespace` (falling back to factory-system, ADR-0011). */
  compile(ref: Ref, namespace: string): Promise<CompiledWorkflow>;
}

// ── Gates ────────────────────────────────────────────────────────────────

/** What should happen once a stage's steps are done. */
export type GateDecision =
  | { action: "advance" }
  | { action: "goto"; stage: string; /** Stage whose retry budget this consumes (ADR-0023, Q1). */ retryOf?: string }
  | { action: "end"; phase: "Done" | "Closed"; reason: string }
  | { action: "await-approval" }
  | { action: "block"; questions: string[] }
  | { action: "fail"; reason: string }
  /** Checks still running in the background; re-evaluate later (never block a reconcile). */
  | { action: "wait"; retryAfterMs: number };

export interface GateContext {
  workItem: WorkItem;
  stage: CompiledStage;
  gate: GateSpec;
}

export interface GateEvaluator {
  /** Matches `gate.type`. */
  readonly type: string;
  evaluate(ctx: GateContext): Promise<GateDecision>;
}

export interface GateEvaluatorLookup {
  get(type: string): GateEvaluator | undefined;
}

/** A single automated check referenced by `gate.checks[]`. */
export interface GateCheck {
  readonly name: string;
  run(ctx: GateContext): Promise<{ passed: boolean; message?: string }>;
}

export interface GateCheckLookup {
  get(name: string): GateCheck | undefined;
}
