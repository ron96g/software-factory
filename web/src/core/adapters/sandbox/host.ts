import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecOptions, ExecResult, ExecutionEnvironment, IsolatedSnapshotEnvironment, Sandbox, SandboxHealthInfo, SandboxSpec } from "../../ports/index.ts";
import { SandboxUnavailableError } from "../../ports/index.ts";
import { runScrubbed, scrubbedEnv } from "./process.ts";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * ADR-0020: unsandboxed local runtime, explicit opt-in only. Operates in the work item's prepared Workspace
 * (ADR-0021); it never creates or touches checkouts itself.
 */
export class HostEnvironment implements ExecutionEnvironment, IsolatedSnapshotEnvironment {
  readonly runtime = "host";
  readonly isolatesCandidate = false;

  async health(): Promise<SandboxHealthInfo> {
    try {
      const { stdout } = await execFileP("git", ["--version"]);
      return {
        runtime: this.runtime,
        available: true,
        isolation: "none",
        waivesIsolation: true,
        version: stdout.trim().replace("git version ", "git "),
        message: "UNSANDBOXED: commands run as your OS user inside the work item's workspace (ADR-0020)",
      };
    } catch {
      return { runtime: this.runtime, available: false, isolation: "none", message: "git is required for the host runtime" };
    }
  }

  async prepare(spec: SandboxSpec): Promise<Sandbox> {
    const ws = spec.workspaces.find((w) => w.status?.phase === "Ready" && w.status.path);
    if (!ws) throw new SandboxUnavailableError(this.runtime, "the work item has no Ready workspace (ADR-0021)");
    return new HostSandbox(`host-${ws.metadata.name}`, ws.status!.path!, ws.status!.baseCommit!, spec.profile.spec?.env ?? {});
  }

  async prepareIsolated(spec: SandboxSpec, input: { commit: string; mode: "baseline" | "candidate" }): Promise<Sandbox> {
    const ws = spec.workspaces.find((w) => w.status?.phase === "Ready" && w.status.path);
    if (input.mode !== "baseline" || !ws || !/^[a-f0-9]{40,64}$/.test(input.commit) || ws.status?.baseCommit !== input.commit) {
      throw new SandboxUnavailableError(this.runtime, "a Ready workspace and its exact pinned baseline commit are required");
    }
    const source = await realpath(ws.status.path!);
    const parent = await realpath(dirname(source));
    const root = join(parent, ".factory-baselines");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
      throw new SandboxUnavailableError(this.runtime, "unsafe baseline directory");
    }
    const path = join(root, randomUUID());
    const env = { ...scrubbedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    try {
      await execFileP("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-checkout", "--", source, path], { cwd: parent, env });
      await execFileP("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", input.commit, "--"], { cwd: path, env });
      return new IsolatedHostSandbox(`host-baseline-${ws.metadata.name}`, path, input.commit, spec.profile.spec?.env ?? {});
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
}

class HostSandbox implements Sandbox {
  readonly id: string;
  private readonly dir: string;
  private readonly base: string;
  private readonly env: Record<string, string>;
  private disposed = false;
  constructor(id: string, dir: string, base: string, env: Record<string, string>) {
    this.id = id;
    this.dir = dir;
    this.base = base;
    this.env = env;
  }

  private path(p: string): string {
    const full = resolve(this.dir, p);
    const rel = relative(this.dir, full);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/)[0] === ".git") throw new Error(`path escapes the workspace: ${p}`);
    return full;
  }
  private alive() {
    if (this.disposed) throw new Error(`sandbox ${this.id} is disposed`);
  }

  exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
    this.alive();
    return runScrubbed(command, o.cwd ? this.path(o.cwd) : this.dir, o.timeoutMs, this.env, o.maxOutputBytes);
  }
  async readFile(p: string): Promise<string> {
    this.alive();
    return readFile(this.path(p), "utf8");
  }
  async writeFile(p: string, content: string): Promise<void> {
    this.alive();
    const full = this.path(p);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
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
    this.disposed = true; // the workspace outlives runs (ADR-0021)
  }
}

class IsolatedHostSandbox extends HostSandbox {
  private readonly pathToRemove: string;
  constructor(id: string, dir: string, base: string, env: Record<string, string>) {
    super(id, dir, base, env);
    this.pathToRemove = dir;
  }
  override async dispose(): Promise<void> {
    await super.dispose();
    await rm(this.pathToRemove, { recursive: true, force: true });
  }
}
