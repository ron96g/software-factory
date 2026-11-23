import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeControlChannel,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeJob,
  RuntimeJobResult,
  RuntimeJobSecrets,
  RuntimeJobSpec,
} from "../../ports/index.ts";
import type { Ref } from "../../model/resource.ts";
import { RuntimeRefusedError } from "../../ports/index.ts";
import { scrubbedEnv } from "../sandbox/process.ts";
import { SYSTEM_RO_BINDS } from "../sandbox/bwrap.ts";
import { GIT_HARDENING, gitLocalEnv } from "../workspaces/git-auth.ts";

const execFileP = promisify(execFile);
const SANDBOX_HOME = "/tmp/home";
const RESULT_MAX_BYTES = 4 * 1024 * 1024;
const EVENTS_MAX_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 8000;
const MAX_EVENTS = 5000;

export interface BwrapAgentRuntimeOptions {
  /** Root holding one job directory per run. */
  root: string;
  /** Absolute path to the runner program (the "runtime image" entrypoint). */
  runnerPath: string;
  /** Node binary; defaults to the factory's own (bound read-only). */
  nodeBin?: string;
  /** Extra host directories to bind read-only (toolchains). */
  extraRoBinds?: readonly string[];
  log?: (msg: string) => void;
}

/**
 * ADR-0080 §2/§3/§7: the `bwrap` `AgentRuntime`. It creates a per-run job directory, seeds the workspace from a
 * factory-made bundle, and launches the runner **inside** a bubblewrap namespace: the job dir is read-write, the OS and
 * toolchain roots are read-only, `HOME` is ephemeral, and the network is unshared (`--unshare-net`) so the model proxy
 * and the run tool surface — served on a Unix socket in the job dir — are the only reachable factory endpoints.
 * The factory itself executes no workload code.
 */
export class BwrapAgentRuntime implements AgentRuntime {
  readonly backend = "bwrap";
  private readonly o: BwrapAgentRuntimeOptions;
  private readonly jobs = new Map<string, BwrapRuntimeJob>();

  constructor(o: BwrapAgentRuntimeOptions) {
    this.o = o;
  }

  /** The control socket for a run; the caller serves the proxy + tool surface here before `create`. */
  socketPath(run: Ref): string {
    return join(this.o.root, run.name, "control.sock");
  }

  /** The per-run job directory (also the runner's `FACTORY_JOB_DIR`). */
  jobDir(run: Ref): string {
    return join(this.o.root, run.name);
  }

  control(run: Ref): RuntimeControlChannel {
    return { endpoint: `unix:${this.socketPath(run)}`, prepare: async () => { await mkdir(this.jobDir(run), { recursive: true, mode: 0o700 }); } };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { isolation: "process", network: ["none"], export: "bundle", reattachable: false };
  }

  async health(): Promise<RuntimeHealth> {
    if (process.platform !== "linux") return { backend: this.backend, available: false, message: "bwrap is supported on Linux only" };
    try {
      const [{ stdout }] = await Promise.all([execFileP("bwrap", ["--version"]), execFileP("git", ["--version"])]);
      await execFileP("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--unshare-net", "--", "true"]);
      return { backend: this.backend, available: true, version: stdout.trim(), message: "per-run bubblewrap runtime: job dir rw, OS/toolchain ro, HOME ephemeral, network unshared (ADR-0080 §7)" };
    } catch (e) {
      return { backend: this.backend, available: false, message: `bubblewrap (bwrap) is unavailable or unprivileged namespaces are disabled (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  async create(spec: RuntimeJobSpec, secrets: RuntimeJobSecrets): Promise<RuntimeJob> {
    const existing = this.jobs.get(spec.run.name);
    if (existing) return existing; // idempotent per run (rule 6)

    if (spec.seeds.length !== 1) throw new RuntimeRefusedError("seeds", `the bwrap runtime supports exactly one seed (got ${spec.seeds.length}); multi-repo export is S3`);
    const seed = spec.seeds[0];
    if (!seed.path) throw new RuntimeRefusedError("seed-path", "the bwrap runtime needs a host checkout in the seed to bundle");

    const jobDir = this.jobDir(spec.run);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    try {
      await this.writeSeedBundle(jobDir, seed.path, seed.commit);
      // Tokens are delivered out of band (§3.3): a 0600 file the runner deletes after reading — never in job.json.
      await writeFile(join(jobDir, "job.json"), JSON.stringify(spec), { mode: 0o600 });
      await writeFile(join(jobDir, "secrets.env"),
        `FACTORY_MODEL_TOKEN=${secrets.modelToken}\nFACTORY_TOOL_TOKEN=${secrets.toolToken}\n`, { mode: 0o600 });
    } catch (e) {
      await rm(jobDir, { recursive: true, force: true });
      throw e;
    }

    const args = this.bwrapArgs(jobDir);
    const child = spawn("bwrap", args, {
      env: { ...scrubbedEnv(), FACTORY_JOB_DIR: jobDir, HOME: SANDBOX_HOME },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = new BwrapRuntimeJob({ id: `bwrap-${spec.run.name}`, run: spec.run, jobDir, child, log: this.o.log, onDispose: () => this.jobs.delete(spec.run.name) });
    this.jobs.set(spec.run.name, job);
    return job;
  }

  /** A factory-side, read-only export of the pinned commit as a self-contained bundle (the runner never sees the checkout). */
  private async writeSeedBundle(jobDir: string, source: string, commit: string): Promise<void> {
    const git = async (cwd: string, ...args: string[]) =>
      (await execFileP("git", [...GIT_HARDENING, ...args], { cwd, env: gitLocalEnv(), maxBuffer: 32 * 1024 * 1024 })).stdout;
    const clone = join(jobDir, "seed-repo");
    await git(jobDir, "clone", "--no-local", "--no-checkout", "--quiet", "--", source, clone);
    try {
      await git(clone, "branch", "-f", "factory/seed", commit);
      await git(clone, "bundle", "create", join(jobDir, "seed.bundle"), "factory/seed");
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  }

  private bwrapArgs(jobDir: string): string[] {
    const args = ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", SANDBOX_HOME,
      "--bind", jobDir, jobDir];
    const addRo = (dir: string) => { if (existsSync(dir)) args.push("--ro-bind", dir, dir); };
    for (const dir of SYSTEM_RO_BINDS) addRo(dir);
    for (const dir of this.o.extraRoBinds ?? []) addRo(dir);
    // The runner program is the runtime image's only payload; nothing else of the factory is visible.
    addRo(this.o.runnerPath);
    args.push(
      "--chdir", jobDir,
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--new-session",
      "--die-with-parent", "--cap-drop", "ALL",
      // §7: no host network. The proxy and the tool surface are reached over the Unix socket in the job dir.
      "--unshare-net",
      "--",
      this.o.nodeBin ?? process.execPath, this.o.runnerPath, jobDir,
    );
    return args;
  }
}

interface BwrapRuntimeJobDeps {
  id: string;
  run: Ref;
  jobDir: string;
  child: ChildProcess;
  log?: (msg: string) => void;
  onDispose?: () => void;
}

class BwrapRuntimeJob implements RuntimeJob {
  readonly id: string;
  readonly run: Ref;
  readonly jobDir: string;
  private readonly child: ChildProcess;
  private readonly log?: (msg: string) => void;
  private readonly onDispose?: () => void;
  private completion?: Promise<RuntimeJobResult>;
  private resolveWait?: (r: RuntimeJobResult) => void;
  private disposed = false;
  private stderr = "";

  constructor(d: BwrapRuntimeJobDeps) {
    this.id = d.id;
    this.run = d.run;
    this.jobDir = d.jobDir;
    this.child = d.child;
    this.log = d.log;
    this.onDispose = d.onDispose;
    d.child.stderr?.on("data", (c: Buffer) => { this.stderr = (this.stderr + c.toString()).slice(-8192); });
    d.child.stdout?.on("data", () => {});
    d.child.on("error", (e) => {
      this.log?.(`[runtime ${this.id}] ${e.message}`);
      this.resolveWait?.({ status: "failed", message: `bwrap spawn error: ${e.message}` });
    });
  }

  wait(): Promise<RuntimeJobResult> {
    if (this.completion) return this.completion;
    this.completion = new Promise<RuntimeJobResult>((done) => {
      this.resolveWait = done;
      const finish = async () => {
        try {
          const raw = await readBounded(join(this.jobDir, "result.json"), RESULT_MAX_BYTES);
          if (!raw) {
            done({ status: "failed", message: `the runtime exited without a result${this.stderr ? `: ${this.stderr}` : ""}` });
            return;
          }
          done(sanitizeResult(JSON.parse(raw)));
        } catch (e) {
          // Any read failure (a symlink, a non-regular file, oversize, bad JSON) is a failed run, never a hang (rule 18).
          done({ status: "failed", message: `unreadable result.json: ${e instanceof Error ? e.message : String(e)}` });
        }
      };
      if (this.child.exitCode !== null || this.child.signalCode !== null) void finish();
      else this.child.on("close", () => void finish());
    });
    return this.completion;
  }

  async events(afterSeq = -1): Promise<RuntimeEvent[]> {
    const raw = await readBounded(join(this.jobDir, "events.jsonl"), EVENTS_MAX_BYTES);
    if (!raw) return [];
    const events: RuntimeEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e: RuntimeEvent;
      try { e = JSON.parse(line) as RuntimeEvent; } catch { continue; /* a torn final line */ }
      if (typeof e?.seq !== "number" || typeof e.role !== "string" || typeof e.content !== "string" || e.seq <= afterSeq) continue;
      events.push({ seq: e.seq, role: e.role.slice(0, 64), content: e.content.slice(0, MAX_EVENT_BYTES), meta: e.meta });
      if (events.length >= MAX_EVENTS) break;
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  async export(): Promise<{ bundlePath: string; ref: string }> {
    return { bundlePath: join(this.jobDir, "out.bundle"), ref: "refs/heads/factory/candidate" };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { process.kill(-this.child.pid!, "SIGKILL"); } catch { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    await rm(this.jobDir, { recursive: true, force: true }).catch(() => {});
    this.onDispose?.();
  }
}

/** A runtime's `result.json` is untrusted input: validate it before the factory reads a single field (ADR-0080 §13). */
function sanitizeResult(value: unknown): RuntimeJobResult {
  const o = (value ?? {}) as Record<string, unknown>;
  const status = o.status === "succeeded" || o.status === "failed" || o.status === "waiting" ? o.status : "failed";
  const u = o.usage as { steps?: unknown; tokens?: unknown } | undefined;
  const usage = u && typeof u.steps === "number"
    ? { steps: Math.max(0, Math.floor(u.steps)), ...(typeof u.tokens === "number" ? { tokens: Math.max(0, Math.floor(u.tokens)) } : {}) }
    : undefined;
  return {
    status,
    finish: status === "succeeded" ? o.finish : undefined,
    message: typeof o.message === "string" ? o.message.slice(0, 4000) : undefined,
    retryAfterMs: typeof o.retryAfterMs === "number" ? o.retryAfterMs : undefined,
    usage,
  };
}

/** Reads a small, untrusted file without following symlinks and with a size cap (ADR-0080 §13). */
async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`refusing to read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`refusing to read ${path}: not a regular file`);
    if (st.size > maxBytes) throw new Error(`refusing to read ${path}: ${st.size} bytes exceeds ${maxBytes}`);
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}
