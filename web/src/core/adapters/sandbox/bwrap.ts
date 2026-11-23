import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExecOptions,
  ExecResult,
  ExecutionEnvironment,
  IsolatedSnapshotEnvironment,
  Sandbox,
  SandboxHealthInfo,
  SandboxSpec,
  ShellConfiner,
} from "../../ports/index.ts";
import { SandboxUnavailableError } from "../../ports/index.ts";
import { scrubbedEnv } from "./process.ts";
import { resolveReadInWorkspace, resolveWriteInWorkspace, writeInsideWorkspace } from "./workspace-paths.ts";

const execFileP = promisify(execFile);
const safeGitEnv = () => ({ ...scrubbedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
const git = async (cwd: string, ...args: string[]) =>
  (await execFileP("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: safeGitEnv(),
    maxBuffer: 16 * 1024 * 1024,
  })).stdout;

const DEFAULT_OUTPUT_CAP = 64 * 1024;
const SANDBOX_HOME = "/tmp/home";

/**
 * Standard host OS and toolchain roots mounted read-only when present. Never includes $HOME or factory data.
 * `/etc` is included deliberately (ADR-0081 §3): commands need DNS resolution (`resolv.conf`), TLS roots
 * (`ssl/`) and NSS libraries (`nsswitch.conf`). It is read-only and mostly non-secret.
 */
export const SYSTEM_RO_BINDS = ["/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc", "/opt", "/run/systemd/resolve", "/home/linuxbrew/.linuxbrew"];

export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Read-only Git paths a confined command needs: the worktree's gitdir (its `HEAD`, index and logs), the shared
 * object store (`<common>/objects`) and the worktree's **own** branch ref, so `git status`, `git log` and
 * `git diff` resolve HEAD. The source checkout's `config`, its other branches and `packed-refs` are deliberately
 * not bound (ADR-0081 §2, SEC-19): a sandboxed command must not read another item's branch or the checkout's
 * configuration. Binding only the own branch ref is what keeps bare `git log`/`git status` working — the worktree
 * HEAD is symbolic (`ref: refs/heads/<branch>`).
 */
function worktreeGitBinds(workspace: string): string[] {
  try {
    const dotGit = join(workspace, ".git");
    if (!statSync(dotGit).isFile()) return [];
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return [];
    const gitdir = resolve(workspace, match[1].trim());
    const binds = [gitdir];
    const common = commonGitDir(gitdir);
    if (common) {
      const objects = join(common, "objects");
      if (existsSync(objects)) binds.push(objects);
      const ref = branchRefPath(gitdir);
      if (ref && existsSync(join(common, ref))) binds.push(join(common, ref));
    }
    return binds.filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

/** The shared Git directory a linked worktree points at via its `commondir` file. */
function commonGitDir(gitdir: string): string | undefined {
  const file = join(gitdir, "commondir");
  if (!existsSync(file)) return undefined;
  const common = resolve(gitdir, readFileSync(file, "utf8").trim());
  return existsSync(common) ? common : undefined;
}

/** The worktree's own branch, e.g. `refs/heads/factory/item`, from its symbolic HEAD. */
function branchRefPath(gitdir: string): string | undefined {
  try {
    return /^ref:\s*(refs\/heads\/.+)$/m.exec(readFileSync(join(gitdir, "HEAD"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

export interface BwrapArgsOptions {
  workspace: string;
  cwd: string;
  command: string;
  extraRoBinds?: readonly string[];
  exists?: (path: string) => boolean;
}

/**
 * Builds the `bwrap` argument list for ADR-0079/ADR-0081: read-only OS/toolchain binds, ephemeral `/tmp` and
 * `HOME=/tmp/home`, workspace-only read-write bind, the narrowed worktree git bind set, PID/IPC/UTS/cgroup
 * namespaces, `--new-session`, `--cap-drop ALL` and `--share-net` for outbound package/research network access.
 */
export function buildBwrapArgs(o: BwrapArgsOptions): string[] {
  const exists = o.exists ?? existsSync;
  const workspace = resolve(o.workspace);
  const cwd = resolve(o.cwd);
  const rel = relative(workspace, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`working directory escapes workspace: ${o.cwd}`);

  const args: string[] = [];
  const seen = new Set<string>();
  const addRo = (dir: string) => {
    const abs = resolve(dir);
    if (seen.has(abs) || !exists(abs)) return;
    seen.add(abs);
    args.push("--ro-bind", abs, abs);
  };

  // Mount `/tmp` and the workspace before the read-only binds, so a git bind under `/tmp` (a workspace
  // outside the checkout) is not shadowed by the tmpfs.
  args.push(
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", SANDBOX_HOME,
    "--bind", workspace, workspace,
  );
  for (const dir of SYSTEM_RO_BINDS) addRo(dir);
  for (const dir of o.extraRoBinds ?? []) addRo(dir);
  for (const dir of worktreeGitBinds(workspace)) addRo(dir);
  // ADR-0079: overlay `.git` (worktree pointer file or real dir) read-only so confined commands cannot plant git hooks/fsmonitor.
  const dotGit = join(workspace, ".git");
  if (exists(dotGit)) args.push("--ro-bind", dotGit, dotGit);

  args.push(
    "--chdir", cwd,
    "--unshare-pid",
    // ADR-0081 §3: the cheap hardening flags that make §4's `✓` honest rather than generous.
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--new-session",
    "--die-with-parent",
    "--cap-drop", "ALL",
    "--share-net",
    "--",
    "bash", "-lc", o.command,
  );
  return args;
}

function runBwrap(
  workspace: string,
  cwd: string,
  command: string,
  timeoutMs = 120_000,
  env: Record<string, string> = {},
  extraRoBinds: readonly string[] = [],
  outputCap = DEFAULT_OUTPUT_CAP,
): Promise<ExecResult> {
  const started = Date.now();
  const args = buildBwrapArgs({ workspace, cwd, command, extraRoBinds });
  const childEnv: NodeJS.ProcessEnv = { ...scrubbedEnv(), ...env, HOME: SANDBOX_HOME };
  return new Promise((done) => {
    const child = spawn("bwrap", args, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timeoutNotice = "";
    let truncated = false;
    let timedOut = false;
    const add = (cur: Buffer, chunk: Buffer) => {
      const available = outputCap - cur.length;
      if (chunk.length > available) truncated = true;
      return available === 0 ? cur : Buffer.concat([cur, chunk.subarray(0, available)]);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = add(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = add(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      timeoutNotice = `\n[killed after ${timeoutMs} ms timeout]`;
    }, timeoutMs);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      done({
        exitCode: code ?? 137,
        stdout: stdout.toString(),
        stderr: stderr.toString() + timeoutNotice,
        truncated,
        durationMs: Date.now() - started,
        termination: timedOut ? { kind: "timeout", signal: signal ?? undefined } : signal ? { kind: "signal", signal } : { kind: "exit" },
      });
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      done({ exitCode: 127, stdout: stdout.toString(), stderr: String(e), truncated, durationMs: Date.now() - started, termination: { kind: "spawn-error" } });
    });
  });
}

export interface BwrapEnvironmentOptions {
  /** Additional host directories to bind read-only (e.g. from `FACTORY_BWRAP_RO_BINDS`). */
  extraRoBinds?: readonly string[];
}

/**
 * ADR-0079/ADR-0081: Linux bubblewrap (`bwrap`) runtime. It confines **command execution** (`SandboxExec`, and
 * OpenCode's `shell` through `ShellConfiner`) to the work item's Workspace while preserving outbound network
 * (`--share-net`) and host toolchains. The sandbox's own file capabilities (`readFile`/`writeFile`/`listFiles`/
 * `diff`), OpenCode's file tools, the factory's git plumbing and workspace setup run in the factory process and
 * are **not** confined by this adapter (SEC-1/SEC-10; ADR-0081 §1).
 */
export class BwrapEnvironment implements ExecutionEnvironment, IsolatedSnapshotEnvironment, ShellConfiner {
  readonly runtime = "bwrap";
  readonly isolatesCandidate = true;
  private readonly extraRoBinds: readonly string[];

  constructor(options: BwrapEnvironmentOptions = {}) {
    this.extraRoBinds = options.extraRoBinds ?? [];
  }

  async health(): Promise<SandboxHealthInfo> {
    if (process.platform !== "linux") {
      return { runtime: this.runtime, available: false, isolation: "process", message: "bwrap is supported on Linux only" };
    }
    try {
      const [{ stdout: bwrapOut }] = await Promise.all([execFileP("bwrap", ["--version"]), execFileP("git", ["--version"])]);
      await execFileP("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--share-net", "--", "true"]);
      return {
        runtime: this.runtime,
        available: true,
        isolation: "process",
        confinesShell: true,
        version: bwrapOut.trim(),
        message: "Confines command execution (SandboxExec, OpenCode shell) via bubblewrap: workspace-only rw, ephemeral HOME, PID/IPC/UTS/cgroup namespaces, --cap-drop ALL, network allowed (ADR-0079/0081). File tools, OpenCode file tools, git plumbing and setup run in the factory process.",
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        runtime: this.runtime,
        available: false,
        isolation: "process",
        message: `bubblewrap (bwrap) is not available or unprivileged namespaces are disabled (${detail})`,
      };
    }
  }

  confineShell(input: { workspace: string; cwd: string; command: string; env: Record<string, string | undefined> }): {
    command: string;
    env: Record<string, string | undefined>;
  } {
    const args = buildBwrapArgs({ workspace: input.workspace, cwd: input.cwd, command: input.command, extraRoBinds: this.extraRoBinds });
    const command = `exec bwrap ${args.map(shellQuote).join(" ")}`;
    return { command, env: { ...input.env, HOME: SANDBOX_HOME } };
  }

  async prepare(spec: SandboxSpec): Promise<Sandbox> {
    const ws = spec.workspaces.find((w) => w.status?.phase === "Ready" && w.status.path);
    if (!ws) throw new SandboxUnavailableError(this.runtime, "the work item has no Ready workspace (ADR-0021)");
    return new BwrapSandbox(`bwrap-${ws.metadata.name}`, ws.status!.path!, ws.status!.baseCommit!, spec.profile.spec?.env ?? {}, this.extraRoBinds);
  }

  async prepareIsolated(spec: SandboxSpec, input: { commit: string; mode: "baseline" | "candidate" }): Promise<Sandbox> {
    const ws = spec.workspaces.find((w) => w.status?.phase === "Ready" && w.status.path);
    if (!ws || !/^[a-f0-9]{40,64}$/.test(input.commit) || ws.status?.baseCommit !== input.commit) {
      throw new SandboxUnavailableError(this.runtime, "a Ready workspace and its exact pinned baseline commit are required");
    }
    const source = await realpath(ws.status.path!);
    const parent = await realpath(dirname(source));
    const root = join(parent, input.mode === "baseline" ? ".factory-baselines" : ".factory-candidates");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
      throw new SandboxUnavailableError(this.runtime, "unsafe isolated workspace directory");
    }
    const path = join(root, randomUUID());
    const env = { ...scrubbedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    try {
      if (input.mode === "baseline") {
        await execFileP("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-checkout", "--", source, path], { cwd: parent, env });
        await execFileP("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", input.commit, "--"], { cwd: path, env });
      } else {
        await cp(source, path, { recursive: true, verbatimSymlinks: true });
      }
      return new IsolatedBwrapSandbox(`bwrap-${input.mode}-${ws.metadata.name}`, path, input.commit, spec.profile.spec?.env ?? {}, this.extraRoBinds);
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
}

class BwrapSandbox implements Sandbox {
  readonly id: string;
  private readonly dir: string;
  private readonly base: string;
  private readonly env: Record<string, string>;
  private readonly extraRoBinds: readonly string[];
  private disposed = false;

  constructor(id: string, dir: string, base: string, env: Record<string, string>, extraRoBinds: readonly string[]) {
    this.id = id;
    this.dir = dir;
    this.base = base;
    this.env = env;
    this.extraRoBinds = extraRoBinds;
  }

  private alive() {
    if (this.disposed) throw new Error(`sandbox ${this.id} is disposed`);
  }

  async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
    this.alive();
    const cwd = o.cwd ? await resolveReadInWorkspace(this.dir, o.cwd) : this.dir;
    return runBwrap(this.dir, cwd, command, o.timeoutMs, this.env, this.extraRoBinds, o.maxOutputBytes);
  }

  async readFile(p: string): Promise<string> {
    this.alive();
    return readFile(await resolveReadInWorkspace(this.dir, p), "utf8");
  }

  async writeFile(p: string, content: string): Promise<void> {
    this.alive();
    await writeInsideWorkspace(await resolveWriteInWorkspace(this.dir, p), content);
  }

  async listFiles(glob?: string): Promise<string[]> {
    this.alive();
    const out = await git(this.dir, "ls-files", "--cached", "--others", "--exclude-standard");
    const re = glob ? new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")}$`) : null;
    return out.split("\n").filter((f) => f && (!re || re.test(f)));
  }

  async diff(): Promise<string> {
    await git(this.dir, "add", "-N", ".");
    return git(this.dir, "diff", this.base);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class IsolatedBwrapSandbox extends BwrapSandbox {
  private readonly pathToRemove: string;
  constructor(id: string, dir: string, base: string, env: Record<string, string>, extraRoBinds: readonly string[]) {
    super(id, dir, base, env, extraRoBinds);
    this.pathToRemove = dir;
  }
  override async dispose(): Promise<void> {
    await super.dispose();
    await rm(this.pathToRemove, { recursive: true, force: true });
  }
}
