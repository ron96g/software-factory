import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecOptions, ExecResult, ExecutionEnvironment, Sandbox, SandboxHealthInfo, SandboxSpec } from "../../ports/index.ts";
import { SandboxUnavailableError } from "../../ports/index.ts";

const execFileP = promisify(execFile);
const OUTPUT_CAP = 64 * 1024;
const SAFE_ENV = ["PATH", "HOME", "LANG", "TERM", "USER"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * ADR-0020: unsandboxed local runtime. Explicit opt-in only. Each work item gets a persistent Git worktree
 * (branch `factory/<item>`) under `workspacesDir`; the operator's checkout is never touched.
 */
export class HostEnvironment implements ExecutionEnvironment {
  readonly runtime = "host";
  private readonly root: string;
  private readonly workspacesDir: string;
  constructor(o: { definitionsRoot: string; workspacesDir: string }) {
    this.root = o.definitionsRoot;
    this.workspacesDir = o.workspacesDir;
  }

  async health(): Promise<SandboxHealthInfo> {
    try {
      const { stdout } = await execFileP("git", ["--version"]);
      return {
        runtime: this.runtime,
        available: true,
        isolation: "none",
        waivesIsolation: true,
        version: stdout.trim().replace("git version ", "git "),
        message: "UNSANDBOXED: commands run as your OS user in a per-item Git worktree (ADR-0020)",
      };
    } catch {
      return { runtime: this.runtime, available: false, isolation: "none", message: "git is required for the host runtime" };
    }
  }

  async prepare(spec: SandboxSpec): Promise<Sandbox> {
    const repo = spec.repositories.find((r) => r.spec.local?.path);
    if (!repo) throw new SandboxUnavailableError(this.runtime, "the work item has no repository with spec.local.path");
    const source = isAbsolute(repo.spec.local!.path) ? repo.spec.local!.path : resolve(this.root, repo.spec.local!.path);
    const item = spec.run.spec.workItemRef.name;
    const dir = resolve(this.workspacesDir, item);
    const branch = `factory/${item}`;
    if (!existsSync(join(dir, ".git"))) {
      await mkdir(this.workspacesDir, { recursive: true });
      await git(source, "worktree", "prune");
      const exists = (await git(source, "branch", "--list", branch)).trim();
      await git(source, "worktree", "add", ...(exists ? [dir, branch] : ["-b", branch, dir, "HEAD"]));
    }
    // Diff base: where the branch forked from the source checkout's HEAD (stable across runs).
    const base = (await git(dir, "merge-base", "HEAD", (await git(source, "rev-parse", "HEAD")).trim())).trim();
    return new HostSandbox(`host-${item}`, dir, base);
  }
}

class HostSandbox implements Sandbox {
  readonly id: string;
  private readonly dir: string;
  private readonly base: string;
  private disposed = false;
  constructor(id: string, dir: string, base: string) {
    this.id = id;
    this.dir = dir;
    this.base = base;
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
    const env = Object.fromEntries(SAFE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])) as NodeJS.ProcessEnv;
    const started = Date.now();
    return new Promise((done) => {
      const child = spawn("bash", ["-lc", command], { cwd: o.cwd ? this.path(o.cwd) : this.dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const add = (cur: string, chunk: Buffer) => {
        if (cur.length >= OUTPUT_CAP) {
          truncated = true;
          return cur;
        }
        return (cur + chunk.toString()).slice(0, OUTPUT_CAP);
      };
      child.stdout.on("data", (c: Buffer) => (stdout = add(stdout, c)));
      child.stderr.on("data", (c: Buffer) => (stderr = add(stderr, c)));
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL"); // whole process group
        } catch {}
        stderr += `\n[killed after ${o.timeoutMs ?? 120_000} ms timeout]`;
      }, o.timeoutMs ?? 120_000);
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        done({ exitCode: code ?? 137, stdout, stderr, truncated, durationMs: Date.now() - started });
      });
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        done({ exitCode: 127, stdout, stderr: String(e), truncated, durationMs: Date.now() - started });
      });
    });
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
    await git(this.dir, "add", "-N", "."); // include new files in the diff without staging content
    return git(this.dir, "diff", this.base);
  }
  async dispose(): Promise<void> {
    // The worktree is the work item's workspace and persists across runs (ADR-0020); only this handle ends.
    this.disposed = true;
  }
}
