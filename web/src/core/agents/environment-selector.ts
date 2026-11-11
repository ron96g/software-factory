import type { ExecutionEnvironment, ExecutionEnvironmentSelector, Lookup, SandboxHealthInfo } from "../ports/index.ts";

/**
 * ADR-0019 selection. Explicit runtime wins; `auto` probes candidates in order and takes the first available one.
 * Falls back to the `none` environment. Result is cached until `refresh()`.
 */
export class DefaultEnvironmentSelector implements ExecutionEnvironmentSelector {
  private readonly envs: Lookup<ExecutionEnvironment>;
  private readonly configured: string;
  private readonly order: string[];
  private cached?: Awaited<ReturnType<ExecutionEnvironmentSelector["select"]>>;

  constructor(envs: Lookup<ExecutionEnvironment>, configured: string | undefined, order: string[]) {
    this.envs = envs;
    this.configured = configured || "auto";
    this.order = order;
  }

  async select() {
    if (this.cached) return this.cached;
    const none = this.envs.get("none");
    if (!none) throw new Error("the `none` sandbox environment must be registered");
    const names = this.configured === "auto" ? this.order : [this.configured];
    const candidates: SandboxHealthInfo[] = [];
    for (const name of names) {
      const env = this.envs.get(name);
      if (!env) {
        candidates.push({ runtime: name, available: false, isolation: "none", message: "adapter not installed" });
        continue;
      }
      const health = await env.health().catch(
        (e): SandboxHealthInfo => ({ runtime: name, available: false, isolation: "none", message: e instanceof Error ? e.message : String(e) }),
      );
      candidates.push(health);
      if (health.available) return (this.cached = { environment: env, health, candidates });
    }
    const reason =
      this.configured === "auto"
        ? `no sandbox runtime available (tried: ${candidates.map((c) => `${c.runtime}: ${c.message ?? "unavailable"}`).join("; ") || "none"})`
        : `configured runtime "${this.configured}" is unavailable: ${candidates[0]?.message ?? ""}`;
    const health = { ...(await none.health()), message: reason };
    return (this.cached = { environment: none, health, candidates });
  }

  async refresh(): Promise<void> {
    this.cached = undefined;
    await this.select();
  }
}
