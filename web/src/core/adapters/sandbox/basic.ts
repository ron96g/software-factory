import type { ExecResult, ExecutionEnvironment, Sandbox, SandboxHealthInfo, SandboxSpec } from "../../ports/index.ts";
import { SandboxUnavailableError } from "../../ports/index.ts";

/** ADR-0019: no runtime. Never executes anything; sandbox-requiring stages fall back with a visible reason. */
export class NoSandboxEnvironment implements ExecutionEnvironment {
  readonly runtime = "none";
  private readonly reason: string;
  constructor(reason = "no sandbox runtime configured or detected") {
    this.reason = reason;
  }
  async health(): Promise<SandboxHealthInfo> {
    return { runtime: this.runtime, available: false, isolation: "none", message: this.reason };
  }
  async prepare(): Promise<Sandbox> {
    throw new SandboxUnavailableError(this.runtime, this.reason);
  }
}

type CommandHandler = (cmd: string, files: Map<string, string>) => Partial<ExecResult> | undefined;

/**
 * In-memory sandbox for tests and the contract suite. Commands are answered by registered handlers;
 * it never touches the host.
 */
export class InMemorySandboxEnvironment implements ExecutionEnvironment {
  readonly runtime = "in-memory";
  readonly sandboxes: InMemorySandbox[] = [];
  private readonly seed: Record<string, string>;
  private readonly handlers: CommandHandler[];
  constructor(o: { seed?: Record<string, string>; handlers?: CommandHandler[] } = {}) {
    this.seed = o.seed ?? {};
    this.handlers = o.handlers ?? [];
  }
  async health(): Promise<SandboxHealthInfo> {
    return { runtime: this.runtime, available: true, isolation: "container", version: "test", message: "in-memory fake (tests only)" };
  }
  async prepare(spec: SandboxSpec): Promise<Sandbox> {
    const s = new InMemorySandbox(`mem-${spec.run?.metadata.name ?? spec.workspaces[0]?.metadata.name ?? "check"}`, { ...this.seed }, this.handlers);
    this.sandboxes.push(s);
    return s;
  }
}

export class InMemorySandbox implements Sandbox {
  readonly id: string;
  readonly files: Map<string, string>;
  private readonly original: Map<string, string>;
  private readonly handlers: CommandHandler[];
  readonly log: string[] = [];
  disposed = false;

  constructor(id: string, seed: Record<string, string>, handlers: CommandHandler[]) {
    this.id = id;
    this.files = new Map(Object.entries(seed));
    this.original = new Map(this.files);
    this.handlers = handlers;
  }
  private alive() {
    if (this.disposed) throw new Error(`sandbox ${this.id} is disposed`);
  }
  async exec(command: string): Promise<ExecResult> {
    this.alive();
    this.log.push(command);
    const started = Date.now();
    for (const h of this.handlers) {
      const r = h(command, this.files);
      if (r) return { exitCode: 0, stdout: "", stderr: "", truncated: false, ...r, durationMs: Date.now() - started };
    }
    return { exitCode: 127, stdout: "", stderr: `${command.split(" ")[0]}: command not found`, truncated: false, durationMs: Date.now() - started };
  }
  async readFile(path: string): Promise<string> {
    this.alive();
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`no such file: ${path}`);
    return v;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.alive();
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`path escapes the workspace: ${path}`);
    this.files.set(path, content);
  }
  async listFiles(glob?: string): Promise<string[]> {
    this.alive();
    const re = glob ? new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*")}$`) : null;
    return [...this.files.keys()].filter((f) => !re || re.test(f)).sort();
  }
  async diff(): Promise<string> {
    const out: string[] = [];
    for (const [path, content] of this.files) {
      const before = this.original.get(path);
      if (before === content) continue;
      out.push(`--- a/${path}`, `+++ b/${path}`, ...(before ?? "").split("\n").filter(Boolean).map((l) => `-${l}`), ...content.split("\n").filter(Boolean).map((l) => `+${l}`));
    }
    for (const path of this.original.keys()) if (!this.files.has(path)) out.push(`--- a/${path}`, `+++ /dev/null`);
    return out.join("\n");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
