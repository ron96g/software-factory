import type { AgentExecutor, ExecutionContext, ExecutionGate, ExecutionReadiness } from "../ports/index.ts";
import { noRealExecutorReason } from "./builtin-skills.ts";

/**
 * ADR-0029 `FACTORY_SIMULATION=wait`: a run may only start when a real executor can take it,
 * so missing LLMs or sandboxes never produce placeholder output.
 */
export class RequireRealExecutor implements ExecutionGate {
  private readonly executors: AgentExecutor[];
  private readonly retryAfterMs: number;
  /** `executors`: every executor except the simulated fallback. */
  constructor(executors: AgentExecutor[], retryAfterMs = 30_000) {
    this.executors = executors;
    this.retryAfterMs = retryAfterMs;
  }
  check(ctx: ExecutionContext): ExecutionReadiness {
    if (this.executors.some((e) => e.canExecute(ctx))) return { ready: true };
    return { ready: false, reason: `Waiting instead of simulating: ${noRealExecutorReason(ctx)}`, retryAfterMs: this.retryAfterMs };
  }
}
