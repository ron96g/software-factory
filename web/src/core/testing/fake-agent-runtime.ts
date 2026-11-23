import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  NetworkMode,
  RuntimeCapabilities,
  RuntimeControlChannel,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeJob,
  RuntimeJobSecrets,
  RuntimeJobSpec,
} from "../ports/index.ts";
import { RuntimeRefusedError } from "../ports/index.ts";
import type { IsolationLevel } from "../ports/index.ts";
import type { Ref } from "../model/resource.ts";

export interface FakeAgentRuntimeOptions {
  /** The finish payload the run reports (untrusted; validated factory-side). */
  finish?: unknown;
  status?: "succeeded" | "failed" | "waiting";
  message?: string;
  retryAfterMs?: number;
  usage?: { steps: number; tokens?: number };
  events?: RuntimeEvent[];
  /** The bundle the export returns; a placeholder file is created when absent. */
  bundlePath?: string;
  isolation?: IsolationLevel;
  network?: NetworkMode[];
  reattachable?: boolean;
  available?: boolean;
  /** Root for the (unused) control channel dirs. */
  root?: string;
}

/**
 * ADR-0080 §2: an in-process `AgentRuntime` for tests. It does **not** execute anything: it returns a configured result
 * and a bundle path, so the port contract and the factory-side executor can be exercised without a real backend
 * (S2-a). It is reachable only from tests — never registered in the composition root of a real deployment.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly backend = "fake";
  /** The secrets the last `create` received, for assertions (never logged). */
  lastSecrets?: RuntimeJobSecrets;
  private readonly o: FakeAgentRuntimeOptions;
  private readonly jobs = new Map<string, RuntimeJob>();

  constructor(o: FakeAgentRuntimeOptions = {}) {
    this.o = o;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { isolation: this.o.isolation ?? "process", network: this.o.network ?? ["none", "allowlist"], export: "bundle", reattachable: this.o.reattachable ?? false };
  }

  control(run: Ref): RuntimeControlChannel {
    const dir = mkdtempSync(join(this.o.root ?? tmpdir(), `${run.name}-`));
    const endpoint = `unix:${join(dir, "control.sock")}`;
    return { endpoint, prepare: async () => { mkdirSync(dir, { recursive: true, mode: 0o700 }); } };
  }

  async health(): Promise<RuntimeHealth> {
    return { backend: this.backend, available: this.o.available ?? true, version: "fake", message: "in-process test runtime (S2-a)" };
  }

  async create(spec: RuntimeJobSpec, secrets: RuntimeJobSecrets): Promise<RuntimeJob> {
    this.lastSecrets = secrets;
    const caps = await this.capabilities();
    const wanted = spec.profile.spec?.network?.mode;
    if (wanted && !caps.network.includes(wanted)) {
      throw new RuntimeRefusedError("network", `the fake runtime cannot enforce network mode "${wanted}"; ADR-0080 §7`);
    }
    const key = spec.run.name;
    const existing = this.jobs.get(key);
    if (existing) return existing; // idempotent per run (rule 6)

    const jobDir = mkdtempSync(join(tmpdir(), "sf-runtime-"));
    const bundlePath = this.o.bundlePath ?? join(jobDir, "out.bundle");
    const o = this.o;
    const job: RuntimeJob = {
      id: `fake-${key}`,
      run: spec.run,
      jobDir,
      async wait() {
        return { status: o.status ?? "succeeded", finish: o.finish ?? { summary: "fake runtime run" }, message: o.message, retryAfterMs: o.retryAfterMs, usage: o.usage };
      },
      async events(afterSeq = -1) {
        return (o.events ?? []).filter((e) => e.seq > afterSeq);
      },
      async export() {
        if (o.bundlePath === undefined) writeFileSync(bundlePath, "");
        return { bundlePath, ref: "refs/heads/factory/candidate" };
      },
      async dispose() {},
    };
    this.jobs.set(key, job);
    return job;
  }
}
