import type { CheckRun, ModuleCheckScope, ModuleScopeMode, Repository, WorkItem, Workspace, WorkspaceFileChange } from "../model/kinds.ts";
import type { ExecutionContext } from "./agents.ts";
import type { Principal } from "./app.ts";
import type { ExecResult } from "./sandbox.ts";
import type { TranscriptMessage } from "./transcripts.ts";

export interface WorkspaceSnapshotter {
  fingerprint(workspace: Workspace): Promise<string>;
}

/**
 * ADR-0061 §2: a check must leave the candidate as it found it. The check controller captures the workspace tree before
 * a check runs and restores it afterwards when the check wrote to the workspace, so a command that regenerates files
 * cannot pollute the candidate that is later reviewed and published. The handle is the Git tree object of the captured
 * working copy; a restore writes the tree back and removes files the check added.
 */
export interface WorkspaceCheckpoint {
  /** Captures the current working tree (tracked and non-ignored untracked content) and returns a durable handle. */
  capture(workspace: Workspace): Promise<string>;
  /** Restores the working tree to a captured handle; returns true when the tree had to be changed. */
  restore(workspace: Workspace, checkpoint: string): Promise<boolean>;
}

/** The files that differ between two checkpoints of the same workspace (`from` → `to`). */
export interface WorkspaceCheckpointDiff {
  diff(workspace: Workspace, from: string, to: string): Promise<WorkspaceFileChange[]>;
}

/** ADR-0086: workspace-relative files the candidate changed or added since the workspace's pinned base commit. */
export interface CandidateChanges {
  changedFiles(workspace: Workspace): Promise<string[]>;
}

/** ADR-0094: the unified diff of a workspace against its pinned base commit, clipped to `maxBytes`. Read-only. */
export interface CandidateDiffReader {
  diff(workspace: Workspace, maxBytes: number): Promise<{ stat: string; patch: string; truncated: boolean }>;
}

export interface ModuleScopePlanner {
  /**
   * `selection` is the scope requested by the verification tier (ADR-0061, default `affected`). Shared, unknown or
   * empty changes still return `full` with a reason (ADR-0044); the result is never narrower than requested.
   */
  plan(workspace: Workspace, repository: Repository, selection?: ModuleScopeMode): Promise<ModuleCheckScope>;
}

export interface CheckExecutionRunner {
  execute(run: CheckRun, workspace: Workspace, repository: Repository): Promise<ExecResult>;
}

export interface CheckOption {
  workspace: string;
  repository: string;
  check: string;
  timeoutMs: number;
}

export interface CheckRunQueries {
  inspect(p: Principal, workItem: string): Promise<{ runs: CheckRun[]; options: CheckOption[] }>;
  logs(p: Principal, name: string, afterSeq?: number): Promise<TranscriptMessage[]>;
}

export interface CheckRunCommands {
  submit(p: Principal, workItem: string, input: { workspace: string; check: string; requestId: string }): Promise<CheckRun>;
}

/** Serializes check publication with the entire duration of candidate mutations in this process. */
export interface WorkspaceJobCoordinator {
  mutate<T>(ctx: ExecutionContext, operation: () => Promise<T>): Promise<T>;
  submit<T>(item: WorkItem, operation: () => Promise<T>): Promise<T>;
}
