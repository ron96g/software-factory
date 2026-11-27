/**
 * ADR-0095 §7: a review step gets a factory-built manifest of the change instead of the diff, reads each file's change
 * on demand and acknowledges every in-scope file. Reads and acknowledgements are recorded in the run's transcript, so
 * coverage is derived from recorded evidence, never from the agent's own claim.
 */
import type { AgentRun } from "../model/kinds.ts";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

/** A readable piece of one file's diff: a hunk, or a part of a hunk too large to read at once. */
export interface ChangeSegment {
  /** 1-based, stable within the manifest version. */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  bytes: number;
}

export interface ChangedFile {
  repository: string;
  path: string;
  previousPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  bytes: number;
  module: string;
  inScope: boolean;
  /** Why the file is outside review scope: `generated (header)`, `generated (repository)`, vendored, lockfile, binary. */
  scopeReason?: string;
  /** Why an apparently generated file stays in scope, e.g. its generated header was added by this change. */
  scopeNote?: string;
  segments: ChangeSegment[];
}

export interface ChangeManifest {
  /** Pins reads and acknowledgements: repository, head, base and a hash of the diff. */
  version: string;
  repositories: { name: string; head: string; base: string }[];
  files: ChangedFile[];
}

export const SKIP_REASONS = ["mechanical-rename", "generated", "delegated", "budget-exhausted"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface FileCoverage {
  repository: string;
  path: string;
  state: "reviewed" | "skipped" | "unacknowledged";
  reason?: SkipReason;
  note?: string;
}

export interface ReviewCoverage {
  manifest: string;
  /** In-scope files only. */
  files: FileCoverage[];
  outOfScope: number;
  /** Out-of-scope file count per reason, so a reader sees what was excluded and why. */
  outOfScopeReasons: Record<string, number>;
  /** Files excluded as generated, listed because the exclusion rests partly on the change author's header. */
  generated: string[];
  /** One line for the gate and the published review. */
  summary: string;
}

/** Bound to one run: the `read_change` / `acknowledge_change` tools. */
export interface ChangeReviewSession {
  /** Several files per call, in order, as many segments as fit one tool result; `from` continues a single file. */
  read(input: { paths: string[]; from?: number }): Promise<string>;
  /** Several files per call; each is applied or refused on its own. */
  acknowledge(input: { files: { path: string; outcome: string; reason?: string; note?: string }[] }): Promise<string>;
}

/** Creates the session for a run; executors bind it as the `changes` tool capability. */
export interface ChangeReviewSessions {
  /** `maxSteps`: the run's model step budget, so a skip for budget is accepted only near its end. */
  session(ctx: import("./agents.ts").ExecutionContext, budget?: { maxSteps: number }): ChangeReviewSession | undefined;
}

/**
 * Coverage of a finished (or running) run, from its transcript. Undefined when the run produces no review report or
 * had no change manifest, so callers can ask for any run.
 */
export interface ReviewCoverageReader {
  coverage(run: AgentRun): Promise<ReviewCoverage | undefined>;
}
