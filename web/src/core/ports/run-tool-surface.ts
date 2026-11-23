/**
 * ADR-0080 §5: the run tool surface — the third interface between the planes. Factory tools (`finish`, `run_check`,
 * `check_logs`, `search_knowledge`, `propose_issue`, `fetch_url`) and `ToolServer` tools are exposed to a runtime over
 * this surface. A surface is **bound to one run** and to that run's stored offering, so a runtime cannot widen its own
 * surface; authorization is re-checked per call by the transport (the run-scoped token). No gate, approval or
 * publication tool is ever exposed (rule 8).
 */
import type { Ref } from "../model/resource.ts";
import type { ToolSchema } from "./integration.ts";

export interface RunToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface RunToolSurface {
  /** The one run this surface serves. */
  readonly run: Ref;
  /** The tool schemas this run may call — exactly the stored offering. */
  offering(): Promise<ToolSchema[]>;
  invoke(call: RunToolCall): Promise<{ content: string }>;
}

/** A refused tool call, mapped to HTTP by the surface's listener. */
export class RunToolSurfaceError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The runtime-facing control surface for one run, running in the factory (the model proxy + the tool surface). */
export interface RuntimeControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

/** Starts the control surface on a runtime's control channel. A port so the executor never imports an adapter (rule 3). */
export interface RuntimeControlServerFactory {
  start(input: { endpoint: string; surface: RunToolSurface; modelToken: string; toolToken: string }): Promise<RuntimeControlServer>;
}
