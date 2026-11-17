/**
 * ADR-0060: one embedded OpenCode v2 host per factory process. Each AgentRun execution is one session; the plugin
 * keeps the factory in control of models, tools, skills, permissions, command environments and retries, and every
 * step, tool call and result is written to the run's transcript (rule 14).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCode } from "@opencode/sdk";
import type { Plugin } from "@opencode/plugin";
import type { BoundTool, ModelEndpoint, NewTranscriptMessage, ToolSchema, TranscriptRecorder } from "../../ports/index.ts";
import { ModelUnavailableError } from "../../ports/index.ts";
import { FINISH, WRAP_UP_WARNING, lastStepNotice, wrapUpWarning } from "../../agents/run-harness.ts";
import { PROVIDER_PACKAGES, SAFE_ENV, UNAVAILABLE_STATUS, type PermissionRule } from "./mapping.ts";
import { discoverSkills, type DiscoveredSkill } from "./skills.ts";

type Host = Awaited<ReturnType<typeof OpenCode.create>>;
type PluginContext = Plugin.Context;
type Modules = [typeof import("@opencode/sdk"), typeof import("@opencode/plugin")];

const UNDICI_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
let modules: Promise<Modules> | undefined;
let sdkVersion: string | undefined;

/**
 * Loading OpenCode replaces undici's global dispatcher, which silently drops Node's env proxy
 * (`NODE_USE_ENV_PROXY`) for every `fetch` in the process. Load it lazily and put the process's dispatcher back.
 */
function loadModules(): Promise<Modules> {
  modules ??= (async () => {
    const global = globalThis as Record<symbol, unknown>;
    const saved = global[UNDICI_DISPATCHER];
    const loaded = await Promise.all([import("@opencode/sdk"), import("@opencode/plugin")]);
    try {
      const manifest = join(dirname(fileURLToPath(import.meta.resolve("@opencode/sdk"))), "..", "package.json");
      sdkVersion = (JSON.parse(await readFile(manifest, "utf8")) as { version?: string }).version;
    } catch {
      // provenance then says "opencode" without a version
    }
    if (saved !== undefined && global[UNDICI_DISPATCHER] !== saved) global[UNDICI_DISPATCHER] = saved;
    return loaded;
  })();
  return modules;
}

export interface FinishDecision {
  accepted: boolean;
  /** Tool result shown to the model: an acknowledgement, or the problems to correct. */
  content: string;
}

/** Everything the host needs to run one AgentRun as a session. Built by the executor; no OpenCode types leak out. */
export interface SessionSpec {
  title: string;
  /** Factory agent name (transcript author). */
  agent: string;
  directory: string;
  providerName: string;
  endpoint: ModelEndpoint;
  model: string;
  system: string;
  prompt: string;
  rules: readonly PermissionRule[];
  /** Tools offered to the run's session (OpenCode built-ins, factory tools, `finish`). */
  tools: ReadonlySet<string>;
  /** Tools offered to its sub-agents. */
  childTools: ReadonlySet<string>;
  /** OpenCode built-ins that change the workspace. */
  mutating: ReadonlySet<string>;
  /** Plugin tools of this run (factory tools, ToolServer tools); `finish` is handled by `onFinish`. */
  factoryTools: ReadonlyMap<string, BoundTool>;
  /** Runs a workspace mutation guarded and serialized (ADR-0042/0059). */
  guard(operation: () => Promise<void>): Promise<void>;
  /** Plain profile environment for commands (ADR-0033), on top of the scrubbed base. */
  env: Readonly<Record<string, string>>;
  maxSteps: number;
  continuePrompt: string;
  transcript: TranscriptRecorder;
  metadata: Record<string, string>;
  onFinish(args: Record<string, unknown>, progress: { step: number; calls: Record<string, number> }): Promise<FinishDecision>;
}

export interface SessionOutcome {
  steps: number;
  calls: Record<string, number>;
  /** An accepted `finish`. */
  finished: boolean;
  /** The step budget ran out without an accepted `finish`. */
  exhausted: boolean;
}

export interface OpenCodeHostOptions {
  /** OpenCode's own state (database, empty global config). A cache: the transcript is the record. */
  dataDir: string;
  /** Replaces fetch for model requests (tests, proxies). */
  fetch?: typeof fetch;
  /** Receives OpenCode's warnings and errors. */
  log?: (message: string) => void;
}

interface ProviderEntry {
  name: string;
  endpoint: ModelEndpoint;
  models: Set<string>;
}

interface ProviderError {
  type?: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

/** OpenCode's own tools; plugin tools must never replace them. */
const RESERVED = new Set(["read", "glob", "grep", "list", "edit", "write", "patch", "apply_patch", "shell", "bash", "skill", "subagent", "task",
  "question", "webfetch", "websearch", "execute", "todowrite", "todoread"]);
const SYSTEM = { type: "system" as const, id: "opencode" };

const inside = (dir: string, path: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const resultText = (result: unknown): string => {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: { type?: string; text?: unknown }) => (typeof p?.text === "string" ? p.text : `[${p?.type ?? "content"}]`)).join("\n");
  }
  return JSON.stringify(result ?? null);
};

const toRunError = (e: ProviderError): Error =>
  /rate-limit|overload|unavailable/.test(e.type ?? "") || (e.status !== undefined && UNAVAILABLE_STATUS.has(e.status))
    ? new ModelUnavailableError(e.message, e.status ?? 429, e.retryAfterMs)
    : new Error(`OpenCode session failed: ${e.message}`);

class RunState {
  readonly spec: SessionSpec;
  sessionID = "";
  steps = 0;
  /** Message count of the last model request; an identical count is a provider retry of the same step. */
  lastContext = -1;
  readonly calls: Record<string, number> = {};
  finished = false;
  exhausted = false;
  error?: ProviderError;
  readonly children = new Set<string>();
  readonly pending = new Map<string, { release: () => void; done: Promise<void> }>();
  /** Tool calls whose result was already recorded (refused before execution). */
  readonly resolved = new Set<string>();
  recordError?: unknown;
  private queue: Promise<void> = Promise.resolve();

  constructor(spec: SessionSpec) {
    this.spec = spec;
  }

  /** Ordered and non-blocking, so hooks and the shared event stream never wait on storage. */
  record(message: NewTranscriptMessage) {
    this.queue = this.queue.then(() => this.spec.transcript.record(message)).catch((e) => {
      this.recordError ??= e;
    });
  }

  flush() {
    return this.queue;
  }

  author() {
    return { type: "agent" as const, id: this.spec.agent };
  }

  origin(sessionID: string): Record<string, unknown> {
    return sessionID === this.sessionID ? {} : { subagentSession: sessionID };
  }
}

export class OpenCodeHost {
  private readonly o: OpenCodeHostOptions;
  private instance?: Promise<Host>;
  private readonly contexts = new Set<PluginContext>();
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly toolSchemas = new Map<string, ToolSchema>();
  /** Session ID (run session and its sub-agent sessions) → run. */
  private readonly runs = new Map<string, RunState>();
  private readonly primaries = new Set<RunState>();
  /** Skills per location (session directory), rediscovered when a run starts there. */
  private readonly skills = new Map<string, { list: DiscoveredSkill[]; contexts: Set<PluginContext> }>();

  constructor(o: OpenCodeHostOptions) {
    this.o = o;
  }

  /** e.g. "opencode@2.3.0"; known once the host has started. */
  get runtime(): string {
    return `opencode${sdkVersion ? `@${sdkVersion}` : ""}`;
  }

  async close(): Promise<void> {
    const instance = this.instance;
    this.instance = undefined;
    if (instance) await (await instance).close();
  }

  async run(spec: SessionSpec): Promise<SessionOutcome> {
    const oc = await this.ensure();
    const providerID = await this.registerModel(spec);
    await this.refreshSkills(spec.directory);
    await this.registerTools(spec.factoryTools);
    const st = new RunState(spec);
    const session = await oc.sessions.create({
      location: { directory: spec.directory },
      agent: "build",
      model: { providerID, id: spec.model },
      permissions: [...spec.rules],
      title: spec.title,
      metadata: spec.metadata,
    });
    st.sessionID = session.id;
    this.runs.set(session.id, st);
    this.primaries.add(st);
    st.record({ role: "note", author: SYSTEM, content: `OpenCode session ${session.id} (${this.runtime}) in ${spec.directory}` });
    try {
      await oc.sessions.prompt({ sessionID: session.id, text: spec.prompt });
      for (;;) {
        await this.settle(oc, st);
        if (st.finished || st.exhausted || st.error || st.recordError || st.steps >= spec.maxSteps) break;
        st.record({ role: "user", author: SYSTEM, content: spec.continuePrompt, meta: { step: st.steps } });
        await oc.sessions.prompt({ sessionID: session.id, text: spec.continuePrompt });
      }
    } finally {
      for (const p of st.pending.values()) p.release();
      st.pending.clear();
      // Removal also stops sub-agents still working in the background.
      await oc.sessions.remove({ sessionID: session.id }).catch(() => {});
      this.primaries.delete(st);
      for (const id of [session.id, ...st.children]) this.runs.delete(id);
      await st.flush();
    }
    if (st.recordError) throw st.recordError;
    if (st.error && !st.finished) throw toRunError(st.error);
    return { steps: st.steps, calls: st.calls, finished: st.finished, exhausted: !st.finished && (st.exhausted || st.steps >= spec.maxSteps) };
  }

  private ensure(): Promise<Host> {
    this.instance ??= this.start().catch((e) => {
      this.instance = undefined;
      throw e;
    });
    return this.instance;
  }

  private async start(): Promise<Host> {
    const config = join(this.o.dataDir, "config");
    await mkdir(config, { recursive: true });
    const [{ OpenCode }, values] = await loadModules();
    const oc = await OpenCode.create({
      log: { level: "warn", emit: (entry) => this.o.log?.(`[opencode] ${entry.level}: ${entry.message}`) },
      plugins: [this.plugin(values)],
      // Never repository or user configuration/plugins; never the public model catalogue (ADR-0060 §2).
      config: { project: false, claude: false, directory: config },
      models: { fetch: false, snapshot: true },
      database: { path: join(this.o.dataDir, "opencode.db") },
      fs: { filewatcher: false },
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
    let connected!: () => void;
    const ready = new Promise<void>((r) => (connected = r));
    void this.pump(oc, connected);
    await Promise.race([ready, new Promise((r) => setTimeout(r, 5_000))]);
    return oc;
  }

  private plugin({ Model, Plugin, Provider, Skill }: Modules[1]) {
    const host = this;
    return Plugin.define({
      id: "software-factory",
      async setup(ctx) {
        host.contexts.add(ctx);
        const dir = ctx.location.directory;
        await ctx.provider.transform((editor) => {
          const catalogue = editor.list();
          for (const p of catalogue) editor.remove(p.provider.id);
          for (const [id, p] of host.providers) {
            const pkg = PROVIDER_PACKAGES[p.endpoint.type]!;
            const pid = Provider.ID.make(id);
            editor.add({
              info: { ...Provider.Info.empty(pid), name: `factory/${p.name}`, activation: "enabled", package: pkg.package,
                settings: { baseURL: pkg.baseURL(p.endpoint.baseUrl), apiKey: p.endpoint.apiKey ?? "unused" } },
              models: [...p.models].map((m) => {
                // Limits and capabilities of a known model from OpenCode's bundled snapshot, else defaults.
                const known = catalogue.map((c) => c.models.get(m)).find(Boolean);
                const base = Model.Info.default(pid, Model.ID.make(m));
                return { ...base, name: Model.ID.make(m), ...(known ? { limit: known.limit, capabilities: { ...known.capabilities, tools: true } } : {}) };
              }),
            });
          }
        });
        await ctx.tool.transform((editor) => {
          for (const schema of [FINISH, ...host.toolSchemas.values()]) {
            editor.add({
              name: schema.name,
              description: schema.description,
              input: schema.parameters as never,
              options: { codemode: false },
              execute: async (input: unknown, tc: { sessionID: string }) => ({ content: await host.invoke(schema.name, (input ?? {}) as Record<string, unknown>, tc.sessionID) }) as never,
            });
          }
        });
        // Only the workspace's own skills: nothing built in, from the host user or from the factory's own harness.
        const location = host.skills.get(dir) ?? { list: await discoverSkills(dir), contexts: new Set<PluginContext>() };
        location.contexts.add(ctx);
        host.skills.set(dir, location);
        await ctx.skill.transform((editor) => {
          for (const s of editor.list()) editor.remove(String(s.id));
          for (const skill of location.list) {
            editor.add({ id: Skill.ID.make(skill.name), name: Skill.Name.make(skill.name), description: skill.description,
              path: Skill.Info.fields.path.make(skill.path), content: skill.content });
          }
        });
        await ctx.session.hook("title", (ev) => {
          ev.result = "factory agent run";
        });
        await ctx.session.hook("context", (ev) => host.onContext(ev));
        await ctx.session.hook("retry", (ev) => {
          if (/rate-limit|overload/.test(ev.error.type) || (ev.error.status !== undefined && UNAVAILABLE_STATUS.has(ev.error.status))) ev.decision = { retry: false };
        });
        await ctx.tool.hook("execute.before", (ev) => host.beforeTool(ev));
        await ctx.tool.hook("execute.after", (ev) => host.afterTool(ev));
        await ctx.shell.hook("create.before", (ev) => host.onShell(ev));
        return () => {
          host.contexts.delete(ctx);
          location.contexts.delete(ctx);
        };
      },
    });
  }

  private async registerModel(spec: SessionSpec): Promise<string> {
    if (!PROVIDER_PACKAGES[spec.endpoint.type]) throw new Error(`model provider type "${spec.endpoint.type}" is not supported by OpenCode`);
    // Different keys or endpoints never share a provider entry; the key itself never appears in the ID.
    const id = `factory-${createHash("sha256").update(JSON.stringify([spec.providerName, spec.endpoint.type, spec.endpoint.baseUrl ?? "", spec.endpoint.apiKey ?? ""])).digest("hex").slice(0, 12)}`;
    let entry = this.providers.get(id);
    let changed = false;
    if (!entry) {
      entry = { name: spec.providerName, endpoint: spec.endpoint, models: new Set() };
      this.providers.set(id, entry);
      changed = true;
    }
    if (!entry.models.has(spec.model)) {
      entry.models.add(spec.model);
      changed = true;
    }
    if (changed) await Promise.all([...this.contexts].map((c) => c.provider.reload()));
    return id;
  }

  private async registerTools(tools: ReadonlyMap<string, BoundTool>) {
    let changed = false;
    for (const [name, tool] of tools) {
      if (name === FINISH.name || RESERVED.has(name) || name.startsWith("opencode_")) throw new Error(`tool name "${name}" is reserved by the OpenCode runtime`);
      if (JSON.stringify(this.toolSchemas.get(name)) === JSON.stringify(tool.schema)) continue;
      this.toolSchemas.set(name, tool.schema);
      changed = true;
    }
    if (changed) await Promise.all([...this.contexts].map((c) => c.tool.reload()));
  }

  private async refreshSkills(dir: string) {
    const location = this.skills.get(dir);
    if (!location) return; // discovered when OpenCode first sets up this location
    const list = await discoverSkills(dir);
    if (JSON.stringify(list) === JSON.stringify(location.list)) return;
    location.list = list;
    await Promise.all([...location.contexts].map((c) => c.skill.reload()));
  }

  /** The run a session belongs to; sub-agent sessions resolve to their parent's run. */
  private async stateFor(sessionID: string): Promise<RunState | undefined> {
    const known = this.runs.get(sessionID);
    if (known) return known;
    const oc = await this.instance;
    const info = await oc?.sessions.get({ sessionID }).catch(() => undefined) as { parentID?: string } | undefined;
    if (!info?.parentID) return undefined;
    const parent = await this.stateFor(info.parentID);
    if (parent) {
      this.runs.set(sessionID, parent);
      parent.children.add(sessionID);
    }
    return parent;
  }

  private stateForDirectory(cwd: string): RunState | undefined {
    return [...this.primaries].filter((s) => inside(s.spec.directory, cwd)).sort((a, b) => b.spec.directory.length - a.spec.directory.length)[0];
  }

  private async onContext(ev: { sessionID: string; tools: Record<string, unknown>; system: { type: "text"; text: string }[]; messages: readonly unknown[] }) {
    const st = await this.stateFor(ev.sessionID);
    const noSkills = !this.skills.get(st?.spec.directory ?? "")?.list.length;
    const keep = (names: ReadonlySet<string>) => {
      for (const name of Object.keys(ev.tools)) if (!names.has(name) || (name === "skill" && noSkills)) delete ev.tools[name];
    };
    if (!st) return keep(new Set());
    if (ev.sessionID !== st.sessionID) return keep(st.spec.childTools);
    const max = st.spec.maxSteps;
    // A provider retry resends the same conversation: same step, same tools, recorded once.
    if (ev.messages.length === st.lastContext && st.steps > 0 && st.steps <= max) {
      ev.system.push({ type: "text", text: st.spec.system });
      keep(st.steps === max ? new Set([FINISH.name]) : st.spec.tools);
      return;
    }
    st.lastContext = ev.messages.length;
    const step = ++st.steps;
    if (step > max) {
      st.exhausted = true;
      keep(new Set());
      st.record({ role: "note", author: SYSTEM, content: `[harness] step budget of ${max} used up without an accepted finish; stopping the session`, meta: { step } });
      setImmediate(() => void this.interrupt(st));
      return;
    }
    ev.system.push({ type: "text", text: st.spec.system });
    st.record({ role: "note", author: SYSTEM, content: `Model request: ${st.spec.providerName}/${st.spec.model}`, meta: { step, model: st.spec.model } });
    const left = max - step + 1;
    const notices = [
      ...(step > 1 && left <= WRAP_UP_WARNING ? [wrapUpWarning(left)] : []),
      ...(step === max ? [lastStepNotice(max)] : []),
    ];
    for (const text of notices) {
      ev.system.push({ type: "text", text });
      st.record({ role: "note", author: SYSTEM, content: text, meta: { step } });
    }
    keep(step === max ? new Set([FINISH.name]) : st.spec.tools);
  }

  private async beforeTool(ev: { tool: string; sessionID: string; id: string; input: unknown }) {
    const st = await this.stateFor(ev.sessionID);
    if (!st) throw new Error(`tool "${ev.tool}" is not available outside a factory run`);
    const child = ev.sessionID !== st.sessionID;
    st.calls[ev.tool] = (st.calls[ev.tool] ?? 0) + 1;
    st.record({ role: "tool-call", author: st.author(), content: JSON.stringify(ev.input ?? {}),
      meta: { tool: ev.tool, step: st.steps, callId: ev.id, ...st.origin(ev.sessionID) } });
    try {
      const offered = child ? st.spec.childTools : st.steps >= st.spec.maxSteps ? new Set([FINISH.name]) : st.spec.tools;
      if (!offered.has(ev.tool)) throw new Error(`tool "${ev.tool}" is not available in this ${child ? "sub-agent" : "step"}`);
      // OpenCode's skill tool also resolves skills outside the registry (built-in, user-level): only workspace skills.
      if (ev.tool === "skill") {
        const id = String((ev.input as { id?: unknown } | undefined)?.id ?? "");
        const allowed = this.skills.get(st.spec.directory)?.list.map((k) => k.name) ?? [];
        if (!allowed.includes(id)) throw new Error(`skill "${id}" is not available; skills in this workspace: ${allowed.join(", ") || "none"}`);
      }
      if (st.spec.mutating.has(ev.tool)) await this.acquire(st, ev.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      st.resolved.add(ev.id);
      st.record({ role: "tool-result", author: SYSTEM, content: `error: ${message}`, meta: { tool: ev.tool, step: st.steps, callId: ev.id, ...st.origin(ev.sessionID) } });
      throw e;
    }
  }

  /** Holds the workspace serialization from before the tool runs until it has finished. */
  private async acquire(st: RunState, callId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const done = st.spec.guard(async () => {
      entered();
      await gate;
    });
    done.catch(() => {});
    await Promise.race([inside, done]);
    st.pending.set(callId, { release, done });
  }

  private async afterTool(ev: { tool: string; sessionID: string; id: string } & ({ status: "completed"; result: unknown } | { status: "error"; error: { message: string } })) {
    const st = this.runs.get(ev.sessionID);
    if (!st) return;
    const pending = st.pending.get(ev.id);
    if (pending) {
      st.pending.delete(ev.id);
      pending.release();
      await pending.done.catch(() => {});
    }
    if (st.resolved.delete(ev.id)) return;
    const content = ev.status === "completed" ? resultText(ev.result) : `error: ${ev.error.message}`;
    st.record({ role: "tool-result", author: SYSTEM, content, meta: { tool: ev.tool, step: st.steps, callId: ev.id, ...st.origin(ev.sessionID) } });
    if (ev.tool === FINISH.name && st.finished) setImmediate(() => void this.interrupt(st));
  }

  private async invoke(name: string, input: Record<string, unknown>, sessionID: string): Promise<string> {
    const st = await this.stateFor(sessionID);
    if (!st || st.sessionID !== sessionID) throw new Error(`tool "${name}" is only available to the run's own session`);
    if (name === FINISH.name) {
      const decision = await st.spec.onFinish(input, { step: st.steps, calls: { ...st.calls } });
      if (decision.accepted) st.finished = true;
      return decision.content;
    }
    const tool = st.spec.factoryTools.get(name);
    if (!tool) throw new Error(`tool "${name}" is not available in this run`);
    return tool.invoke(input);
  }

  private onShell(ev: { cwd: string; env: Record<string, string | undefined> }) {
    for (const key of Object.keys(ev.env)) if (!SAFE_ENV.includes(key)) ev.env[key] = undefined;
    Object.assign(ev.env, this.stateForDirectory(ev.cwd)?.spec.env ?? {});
  }

  private async interrupt(st: RunState) {
    const oc = await this.instance;
    await oc?.sessions.interrupt({ sessionID: st.sessionID, resume: false }).catch(() => {});
  }

  /** Waits until the run's session and its sub-agents are idle; sub-agent results wake the parent again. */
  private async settle(oc: Host, st: RunState) {
    for (;;) {
      await oc.sessions.wait({ sessionID: st.sessionID });
      if (st.finished || st.exhausted || st.error) return;
      const active = await oc.sessions.active().catch(() => ({})) as Record<string, unknown>;
      const busy = [...st.children].filter((id) => id in active);
      if (!busy.length && !(st.sessionID in active)) return;
      for (const id of busy) await oc.sessions.wait({ sessionID: id }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async pump(oc: Host, connected: () => void) {
    try {
      for await (const event of oc.events.subscribe()) {
        if (event.type === "server.connected") connected();
        await this.onEvent(event as { type: string; data?: Record<string, unknown> }).catch(() => {});
      }
    } catch {
      // The host closed; runs still in flight fail through their own session calls.
    }
  }

  private readonly handlers: Record<string, (st: RunState, sessionID: string, data: Record<string, unknown>) => void> = {
    "session.created": (st, id, d) => st.record({ role: "note", author: SYSTEM, content: `sub-agent started (${String(d.agent ?? "agent")})`, meta: { step: st.steps, ...st.origin(id) } }),
    "session.text.ended": (st, id, d) => {
      if (typeof d.text === "string" && d.text.trim()) st.record({ role: "assistant", author: st.author(), content: d.text, meta: { step: st.steps, ...st.origin(id) } });
    },
    "session.step.ended": (st, id, d) => {
      const usage = d.tokens as { input?: number; output?: number } | undefined;
      st.record({ role: "note", author: SYSTEM, content: `model step ended (${String(d.finish)})`,
        meta: { step: st.steps, tokens: { prompt: usage?.input, completion: usage?.output }, usage: d.tokens, cost: d.cost, ...st.origin(id) } });
    },
    "session.retry.scheduled": (st, id, d) => st.record({ role: "note", author: SYSTEM, content: `provider retry scheduled: ${(d.error as ProviderError | undefined)?.message ?? "unknown error"}`,
      meta: { step: st.steps, attempt: d.attempt, ...st.origin(id) } }),
    "session.step.failed": (st, id, d) => st.record({ role: "note", author: SYSTEM, content: `model step failed: ${(d.error as ProviderError | undefined)?.message ?? "unknown error"}`,
      meta: { step: st.steps, ...st.origin(id) } }),
    "session.execution.failed": (st, id, d) => {
      if (id === st.sessionID) st.error = d.error as ProviderError;
    },
    "session.compaction.ended": (st, id) => st.record({ role: "note", author: SYSTEM, content: "context compacted", meta: { step: st.steps, ...st.origin(id) } }),
  };

  private async onEvent(event: { type: string; data?: Record<string, unknown> }) {
    const handler = this.handlers[event.type];
    const sessionID = event.data?.sessionID;
    if (!handler || typeof sessionID !== "string") return;
    if (event.type === "session.created" && typeof event.data?.parentID !== "string") return;
    const st = await this.stateFor(sessionID);
    if (st) handler(st, sessionID, event.data!);
  }
}
