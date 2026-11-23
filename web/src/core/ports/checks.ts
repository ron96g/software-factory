import type { CheckRun, ModuleCheckScope, ModuleScopeMode, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import type { ExecutionContext } from "./agents.ts";
import type { Principal } from "./app.ts";
import type { ExecResult } from "./sandbox.ts";
import type { TranscriptMessage } from "./transcripts.ts";

export interface WorkspaceSnapshotter {
  fingerprint(workspace: Workspace): Promise<string>;
}

/** ADR-0079: workspace-relative files the candidate changed or added since the workspace's pinned base commit. */
export interface CandidateChanges {
  changedFiles(workspace: Workspace): Promise<string[]>;
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
