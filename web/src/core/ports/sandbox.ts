/**
 * Sandbox ports (ADR-0019). Capabilities are segregated so tools depend only on what they use (ISP).
 * Runtime adapters (podman, docker, kubernetes, remote, none) implement ExecutionEnvironment.
 */
import type { AgentRun, Repository, SandboxProfile, Workspace } from "../model/kinds.ts";

export type IsolationLevel = "none" | "process" | "container" | "microvm";

export const ISOLATION_RANK: Record<IsolationLevel, number> = { none: 0, process: 1, container: 2, microvm: 3 };

export interface SandboxSpec {
  run: AgentRun;
  profile: SandboxProfile;
  repositories: Repository[];
  /** Ready workspaces of the work item (ADR-0021); the sandbox operates in them. */
  workspaces: Workspace[];
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Relative to the workspace root. */
  cwd?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Output was cut to the adapter's limit. */
  truncated: boolean;
  durationMs: number;
}

export interface SandboxExec {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

/** Read-only file access (sandbox or a plain workspace). */
export interface FileReader {
  readFile(path: string): Promise<string>;
  listFiles(glob?: string): Promise<string[]>;
}

/** Write access, only ever provided by a sandbox (ADR-0019). */
export interface FileWriter {
  writeFile(path: string, content: string): Promise<void>;
}

export type SandboxFiles = FileReader & FileWriter;

export interface SandboxArtifacts {
  /** Unified diff of the workspace against its starting point. */
  diff(): Promise<string>;
}

export interface SandboxLifecycle {
  readonly id: string;
  /** Idempotent. */
  dispose(): Promise<void>;
}

export type Sandbox = SandboxExec & SandboxFiles & SandboxArtifacts & SandboxLifecycle;

export interface SandboxHealthInfo {
  runtime: string;
  available: boolean;
  isolation: IsolationLevel;
  /** Explicitly opted-in runtime that waives profile minimum isolation (ADR-0020 `host`). */
  waivesIsolation?: boolean;
  version?: string;
  message?: string;
}

export interface SandboxHealth {
  health(): Promise<SandboxHealthInfo>;
}

export interface ExecutionEnvironment extends SandboxHealth {
  /** Registry key, e.g. "podman", "kubernetes", "none". */
  readonly runtime: string;
  prepare(spec: SandboxSpec): Promise<Sandbox>;
}

/** Picks the runtime (explicit or auto-detected). Cached after the first call; `refresh` re-probes. */
export interface ExecutionEnvironmentSelector {
  select(): Promise<{ environment: ExecutionEnvironment; health: SandboxHealthInfo; candidates: SandboxHealthInfo[] }>;
  refresh(): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  readonly runtime: string;
  constructor(runtime: string, message: string) {
    super(message);
    this.runtime = runtime;
  }
}
