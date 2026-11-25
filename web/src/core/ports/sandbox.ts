/**
 * Sandbox ports (ADR-0019). Capabilities are segregated so tools depend only on what they use (ISP).
 * Runtime adapters (podman, docker, kubernetes, remote, none) implement ExecutionEnvironment.
 */
import type { AgentRun, Repository, SandboxProfile, Workspace } from "../model/kinds.ts";

export type IsolationLevel = "none" | "process" | "container" | "microvm";

export const ISOLATION_RANK: Record<IsolationLevel, number> = { none: 0, process: 1, container: 2, microvm: 3 };

export interface SandboxSpec {
  /** The agent run, if the sandbox serves one (checks run without a run). */
  run?: AgentRun;
  profile: SandboxProfile;
  repositories: Repository[];
  /** Ready workspaces of the work item (ADR-0021); the sandbox operates in them. */
  workspaces: Workspace[];
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Relative to the workspace root. */
  cwd?: string;
  /** Per-stream capture limit; output beyond it is reported as truncated. Adapters default to a small cap. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Output was cut to the adapter's limit. */
  truncated: boolean;
  durationMs: number;
  termination?: { kind: "exit" | "timeout" | "signal" | "spawn-error"; signal?: string };
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
  version?: string;
  message?: string;
  /**
   * True when this runtime can confine an external shell invocation (it implements `ShellConfiner`), so OpenCode's
   * `shell` tool may run on it (ADR-0060 §4, ADR-0079). False or absent means OpenCode falls back to the tool loop.
   */
  confinesShell?: boolean;
}

export interface SandboxHealth {
  health(): Promise<SandboxHealthInfo>;
}

export interface ExecutionEnvironment extends SandboxHealth {
  /** Registry key, e.g. "podman", "kubernetes", "none". */
  readonly runtime: string;
  prepare(spec: SandboxSpec): Promise<Sandbox>;
}

/** Separate disposable checkout; never changes the WorkItem's candidate workspace. */
export interface IsolatedSnapshotEnvironment {
  /** True only where commands cannot reach or change the candidate workspace. */
  readonly isolatesCandidate: boolean;
  prepareIsolated(spec: SandboxSpec, input: { commit: string; mode: "baseline" | "candidate"; snapshot?: string }): Promise<Sandbox>;
}

export function canPrepareIsolated(environment: ExecutionEnvironment): environment is ExecutionEnvironment & IsolatedSnapshotEnvironment {
  return typeof (environment as Partial<IsolatedSnapshotEnvironment>).prepareIsolated === "function";
}

/** Confines an external shell invocation (e.g. OpenCode's shell tool) to a workspace (ADR-0079). */
export interface ShellConfiner {
  confineShell(input: { workspace: string; cwd: string; command: string; env: Record<string, string | undefined> }): {
    command: string;
    env: Record<string, string | undefined>;
  };
}

export function canConfineShell(environment: ExecutionEnvironment): environment is ExecutionEnvironment & ShellConfiner {
  return typeof (environment as Partial<ShellConfiner>).confineShell === "function";
}

/** ADR-0092: what the sandboxed commit job is asked to produce. */
export interface CandidateCommitInput {
  /** The branch the bundle carries (`refs/heads/<branch>`), e.g. the workspace's `factory/<item>`. */
  branch: string;
  message: string;
  /** Factory-owned scratch directory, read-write in the job; the bundle is written there. */
  outDir: string;
  /** Registered commit hook setup (e.g. `pre-commit`); absent: hooks stay disabled. */
  hooks?: string;
}

/** The job's output: a self-contained bundle, untrusted until ingested (ADR-0080 §13). */
export interface CandidateCommit {
  bundlePath: string;
  ref: string;
  /** Commit the bundle's ref points at, as reported by the job. */
  commit: string;
  /** Tree staged from the working copy; the committed tree equals it (hooks may check, never change). */
  tree: string;
}

/** A hook run or the job itself rejected the commit; `output` is the job's redactable log. */
export class CandidateCommitRejectedError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/**
 * ADR-0092: commits the workspace's working copy **inside** the sandbox (read-only workspace, private git directory,
 * no token) and bundles it. The factory only ingests and pushes the bundle.
 */
export interface SandboxCommitter {
  commitCandidate(spec: SandboxSpec, input: CandidateCommitInput): Promise<CandidateCommit>;
}

export function canCommitCandidate(environment: ExecutionEnvironment): environment is ExecutionEnvironment & SandboxCommitter {
  return typeof (environment as Partial<SandboxCommitter>).commitCandidate === "function";
}

/** ADR-0092: a registered way to install a repository's commit hooks into the job's private git directory. */
export interface CommitHookSetup {
  readonly type: string;
  /** Shell run in the job (cwd = workspace, `GIT_DIR` = private git directory) before `git commit`. */
  readonly install: string;
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
