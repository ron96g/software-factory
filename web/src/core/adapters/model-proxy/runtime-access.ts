import type { ModelTokenStore, RuntimeModelAccess } from "../../ports/index.ts";
import type { Ref } from "../../model/resource.ts";

/**
 * ADR-0080 §4: the factory side of run-scoped model access. It issues a grant on the `ModelTokenStore` bound to one
 * run and hands the runtime only the proxy's base URL and the token — never a provider key.
 */
export class DefaultRuntimeModelAccess implements RuntimeModelAccess {
  private readonly tokens: ModelTokenStore;
  private readonly baseUrl: string;
  private readonly clock: () => Date;
  private readonly defaultTtlSeconds: number;

  constructor(d: { tokens: ModelTokenStore; baseUrl?: string; clock?: () => Date; defaultTtlSeconds?: number }) {
    this.tokens = d.tokens;
    this.baseUrl = d.baseUrl ?? "";
    this.clock = d.clock ?? (() => new Date());
    this.defaultTtlSeconds = d.defaultTtlSeconds ?? 3600;
  }

  async issue(run: Ref, grant: { providerRef: Ref; models: string[]; agent?: string; tier?: string; maxCalls?: number; ttlSeconds?: number }): Promise<{ baseUrl: string; token: string }> {
    const expiresAt = new Date(this.clock().getTime() + (grant.ttlSeconds ?? this.defaultTtlSeconds) * 1000).toISOString();
    const state = await this.tokens.issue({
      run,
      namespace: run.namespace ?? "default",
      providerRef: grant.providerRef,
      agent: grant.agent,
      tier: grant.tier,
      models: grant.models,
      maxCalls: grant.maxCalls,
      expiresAt,
    });
    return { baseUrl: this.baseUrl, token: state.token };
  }

  revoke(run: Ref): Promise<number> {
    return this.tokens.revokeRun(run);
  }
}
