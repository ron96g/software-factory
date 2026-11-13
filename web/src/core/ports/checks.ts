import type { CheckRun, ModuleCheckScope, Repository, Workspace } from "../model/kinds.ts";
import type { Principal } from "./app.ts";
import type { ExecResult } from "./sandbox.ts";
import type { TranscriptMessage } from "./transcripts.ts";

export interface WorkspaceSnapshotter {
  fingerprint(workspace: Workspace): Promise<string>;
}

export interface ModuleScopePlanner {
  plan(workspace: Workspace, repository: Repository): Promise<ModuleCheckScope>;
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
