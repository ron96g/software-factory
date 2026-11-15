/**
 * Workflow ports: compile declarative Workflows into a flat stage list and evaluate gates.
 * Gate types and automated checks are extension points (Strategy + Registry).
 */
import type { Ref } from "../model/resource.ts";
import type { GateSpec, StageSpec, StepSpec, WorkItem, TicketPublication } from "../model/kinds.ts";

export interface CompiledStage {
  name: string;
  publish?: StageSpec["publish"];
  loop?: StageSpec["loop"];
  /** AI-DLC phase (inception / construction / operations). */
  lifecyclePhase: string;
  /** Workflow that declared the stage (sub-workflows are inlined). */
  origin: string;
  originNamespace?: string;
  mode?: string;
  steps: StepSpec[];
  gate?: GateSpec;
}

export interface CompiledWorkflow {
  name: string;
  versions?: Record<string, string>;
  verification?: import("../model/kinds.ts").WorkflowSpec["verification"];
  planning?: import("../model/kinds.ts").WorkflowSpec["planning"];
  unitExecution?: import("../model/kinds.ts").WorkflowSpec["unitExecution"];
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
  | { action: "await-approval"; ticketPublication?: TicketPublication; verification?: import("../model/kinds.ts").ApprovalSpec["verification"]; retrospective?: { fingerprint: string };
      /** Extra facts the human must see on this approval (e.g. known evidence gaps). */
      criteria?: string[];
      /** Who may decide, when not the current stage's approvers (e.g. plan re-confirmation uses the review stage's). */
      approvers?: import("../model/kinds.ts").ApprovalSpec["approvers"] }
  | { action: "block"; questions: string[]; /** Supporting Markdown (e.g. an agent's last summary), kept out of the question text. */ details?: string }
  | { action: "attention"; reason: string }
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

/**
 * ADR-0049: deterministic structure check of an artifact right after its producing step, selected by artifact type.
 * Returns a problem description for the producing agent, or undefined when the artifact is well-formed.
 */
export const OUTPUT_REJECTED = "OutputRejected";

export interface ArtifactCheck {
  readonly artifactType: string;
  check(item: WorkItem, artifact: import("../model/kinds.ts").Artifact): Promise<string | undefined>;
}

/** ADR-0057: the producing run as it saw its inputs, whether the artifact is still proposed or already persisted. */
export interface ArtifactProducer {
  runName: string;
  stage: string;
  /** Input artifact name → resourceVersion. */
  inputs: Record<string, string>;
  /** Context source → revision. */
  contexts: Record<string, string>;
  outcome?: string;
  questions: string[];
  /** Repositories of the producing run's pinned workspaces. */
  repositories: string[];
}

export interface ProposedArtifact {
  item: WorkItem;
  type: string;
  content: string;
  producer: ArtifactProducer;
  /**
   * Read-only access to the producer's pinned workspaces, for checks that verify code locations.
   * `null` when they are no longer readable at the recorded commits; such checks must fail, never pass.
   */
  files: import("./sandbox.ts").FileReader | null;
}

/**
 * ADR-0057: one check implementation for an artifact type, used both in-loop (before `finish` ends the run) and
 * post-run (adapted to `ArtifactCheck`). Side-effect free. Returns an actionable problem or undefined.
 */
export interface ProposedArtifactCheck {
  readonly artifactType: string;
  check(artifact: ProposedArtifact): Promise<string | undefined>;
}

/** A single automated check referenced by `gate.checks[]`. */
export interface GateCheck {
  readonly name: string;
  run(ctx: GateContext): Promise<{ passed: boolean; message?: string }>;
}

export interface GateCheckLookup {
  get(name: string): GateCheck | undefined;
}
