/**
 * ADR-0080 §2: the `AgentRuntime` port — the run job API (in) and the export contract (out), from the factory's side.
 * A runtime is created per run, does one thing, and is disposed; the factory consumes its outputs as **data**. The
 * other two interfaces are the model proxy (`ports/model-proxy.ts`) and the run tool surface
 * (`ports/run-tool-surface.ts`).
 *
 * ISP: the read surfaces are segregated, so a consumer that only needs the exported commit depends on `RuntimeExporter`
 * alone. A runtime is only a runtime when a real primitive enforces it (ADR-0080 §2) — there is no unsandboxed backend.
 */
import type { SandboxProfile } from "../model/kinds.ts";
import type { Ref } from "../model/resource.ts";
import type { IsolationLevel } from "./sandbox.ts";

/** A network mode a backend can enforce (mirrors `SandboxProfile.spec.network.mode`). ADR-0080 §7. */
export type NetworkMode = "none" | "allowlist";

/** The run job protocol version written into the job; a runner that does not know it refuses the job. */
export const RUNTIME_PROTOCOL = 1;

/** What a backend can actually provide; `create` refuses a profile it cannot satisfy rather than degrading. */
export interface RuntimeCapabilities {
  /** The strongest isolation this backend provides. Compared with `profile.isolation` via `decideIsolation`. */
  isolation: IsolationLevel;
  /** Network modes the backend can enforce. A profile asking for anything else is refused at create time. */
  network: NetworkMode[];
  export: "bundle";
  /** A run can be observed again after a factory restart (S3). */
  reattachable: boolean;
}

export interface RuntimeHealth {
  backend: string;
  available: boolean;
  version?: string;
  message?: string;
}

/** One run's inputs. Endpoints only — tokens are delivered out of band, never serialized here (ADR-0080 §4). */
export interface RuntimeJobSpec {
  run: Ref;
  namespace: string;
  /** A pinned runtime image/rootfs (for bwrap: a hash of the runner and the bound toolchain roots). */
  image: string;
  profile: SandboxProfile;
  /** The code the runtime works on: `repo@commit` seeds it checks out. `path` is the host checkout the seed bundle is made from (bwrap). */
  seeds: { repository: string; commit: string; path?: string }[];
  /** Where the model proxy is reachable from inside the runtime. */
  model: { baseUrl: string; name?: string };
  /** Where the run tool surface is reachable from inside the runtime. */
  tools: { baseUrl: string };
  task: { system: string; user: string; maxSteps: number; protocol: number };
  budgets: { ttlSeconds: number };
}

export interface RuntimeJobResult {
  status: "succeeded" | "failed" | "waiting";
  /** Raw `finish` arguments — UNTRUSTED. The factory validates them (`finish` is a tool-surface call, ADR-0057). */
  finish?: unknown;
  /** Why a run failed or is waiting (e.g. quota, ADR-0031). */
  message?: string;
  /** Provider-requested delay when `status` is `waiting` (ADR-0031). */
  retryAfterMs?: number;
  usage?: { steps: number; tokens?: number };
}

/** An untrusted transcript event submitted by the runtime; stored marked `runtime-reported` (ADR-0080 §8). */
export interface RuntimeEvent {
  /** Monotonic within a run; a gap is recorded, never silently ignored. */
  seq: number;
  role: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface RuntimeJobControl {
  wait(): Promise<RuntimeJobResult>;
  /** Idempotent. */
  dispose(): Promise<void>;
}

export interface RuntimeEventReader {
  events(afterSeq?: number): Promise<RuntimeEvent[]>;
}

/** The one interface where data flows **into** the factory; the caller ingests it via `ExportIngestor` (ADR-0080 §13). */
export interface RuntimeExporter {
  export(): Promise<{ bundlePath: string; ref: string }>;
}

export type RuntimeJob =
  & RuntimeJobControl
  & RuntimeEventReader
  & RuntimeExporter
  & { readonly id: string; readonly run: Ref; readonly jobDir: string };

/** Secrets delivered to the runtime **out of band** — never serialized into `RuntimeJobSpec`, logged or prompted (ADR-0080 §4/§16). */
export interface RuntimeJobSecrets {
  /** The run-scoped token the model proxy verifies. */
  modelToken: string;
  /** The token the run tool surface verifies (the same run-scoped token for now, ADR-0080 §5). */
  toolToken: string;
}

/** A control channel the factory serves the model proxy and the run tool surface on, for one run (ADR-0080 §4/§5). */
export interface RuntimeControlChannel {
  /** `unix:/abs/path` (bwrap) or `http://host:port` (a container runtime later). */
  readonly endpoint: string;
  /** Ensures the endpoint's parent exists so the factory can listen. Idempotent. */
  prepare(): Promise<void>;
}

/** ADR-0080 §2: one port, several backends. Idempotent per (run.uid, round) (rule 6). */
export interface AgentRuntime {
  readonly backend: string;
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<RuntimeHealth>;
  /** The endpoint the factory must serve the proxy and the tool surface on for this run. */
  control(run: Ref): RuntimeControlChannel;
  create(job: RuntimeJobSpec, secrets: RuntimeJobSecrets): Promise<RuntimeJob>;
}

/** Why a create was refused; a machine-readable reason for the audit record. */
export class RuntimeRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Issues and revokes the run-scoped model tokens the proxy and the tool surface verify (ADR-0080 §4). */
export interface RuntimeModelAccess {
  /** Issues a token for a run and returns the proxy base URL the runtime should call. */
  issue(run: Ref, grant: { providerRef: Ref; models: string[]; agent?: string; tier?: string; maxCalls?: number; ttlSeconds?: number }): Promise<{ baseUrl: string; token: string }>;
  /** Revokes every token bound to a run (called when the run ends). Returns how many were revoked. */
  revoke(run: Ref): Promise<number>;
}

/** Picks a backend explicitly or by `auto` health; cached after the first call, `refresh` re-probes (mirrors the sandbox selector). */
export interface AgentRuntimeSelector {
  /** `runtime` is undefined when no backend is available (there is no unsandboxed fallback — ADR-0080 §2). */
  select(): Promise<{ runtime?: AgentRuntime; health: RuntimeHealth; candidates: RuntimeHealth[] }>;
  refresh(): Promise<void>;
}
