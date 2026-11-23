import type { AgentRuntime, AgentRuntimeSelector, Lookup, RuntimeHealth } from "../ports/index.ts";

/**
 * ADR-0080 §2: selects an `AgentRuntime` backend. Explicit selection wins; `auto` probes registered backends in order and
 * takes the first available one. There is **no** unsandboxed fallback: when none is available `runtime` is undefined and
 * the caller simulates or waits (ADR-0029). Result cached until `refresh()`.
 */
export class DefaultAgentRuntimeSelector implements AgentRuntimeSelector {
  private readonly runtimes: Lookup<AgentRuntime>;
  private readonly configured: string;
  private readonly order: string[];
  private cached?: Awaited<ReturnType<AgentRuntimeSelector["select"]>>;

  constructor(runtimes: Lookup<AgentRuntime>, configured: string | undefined, order: string[]) {
    this.runtimes = runtimes;
    this.configured = configured || "auto";
    this.order = order;
  }

  async select() {
    if (this.cached) return this.cached;
    const names = this.configured === "auto" ? this.order : [this.configured];
    const candidates: RuntimeHealth[] = [];
    for (const name of names) {
      const runtime = this.runtimes.get(name);
      if (!runtime) {
        candidates.push({ backend: name, available: false, message: "backend not registered" });
        continue;
      }
      const health = await runtime.health().catch(
        (e): RuntimeHealth => ({ backend: name, available: false, message: e instanceof Error ? e.message : String(e) }),
      );
      candidates.push(health);
      if (health.available) return (this.cached = { runtime, health, candidates });
    }
    const message = this.configured === "auto"
      ? `no AgentRuntime backend is available (tried: ${candidates.map((c) => `${c.backend}: ${c.message ?? "unavailable"}`).join("; ") || "none"})`
      : `AgentRuntime backend "${this.configured}" is unavailable: ${candidates[0]?.message ?? ""}`;
    return (this.cached = { runtime: undefined, health: { backend: this.configured, available: false, message }, candidates });
  }

  async refresh(): Promise<void> {
    this.cached = undefined;
    await this.select();
  }
}
