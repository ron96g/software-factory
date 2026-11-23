import { randomUUID } from "node:crypto";
import type { ModelProxyGrant, ModelProxyGrantState, ModelTokenStore } from "../../ports/index.ts";

/**
 * ADR-0080 §4: in-memory run-scoped model tokens. Tokens are short-lived, bound to one run, and revoked when the run
 * ends, so they do not need to outlive the process (X42 moves run state to the store for restart re-attachment).
 */
export class InMemoryModelTokens implements ModelTokenStore {
  private readonly tokens = new Map<string, ModelProxyGrantState>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async issue(grant: ModelProxyGrant): Promise<ModelProxyGrantState> {
    const token = `sfm_${randomUUID().replaceAll("-", "")}`;
    const state: ModelProxyGrantState = { ...grant, token, issuedAt: this.clock().toISOString(), calls: 0, tokens: 0, revoked: false };
    this.tokens.set(token, state);
    return state;
  }

  async verify(token: string): Promise<ModelProxyGrantState | undefined> {
    const state = this.tokens.get(token);
    if (!state || state.revoked || Date.parse(state.expiresAt) <= this.clock().getTime()) return undefined;
    return state;
  }

  async charge(token: string, usage: { calls: number; tokens: number }): Promise<ModelProxyGrantState | undefined> {
    const state = await this.verify(token);
    if (!state) return undefined;
    state.calls += usage.calls;
    state.tokens += usage.tokens;
    return state;
  }

  async revoke(token: string): Promise<void> {
    const state = this.tokens.get(token);
    if (state) state.revoked = true;
  }

  async revokeRun(run: { name: string; namespace?: string }): Promise<number> {
    let n = 0;
    for (const state of this.tokens.values()) {
      if (!state.revoked && state.run.name === run.name && (state.run.namespace ?? state.namespace) === (run.namespace ?? state.namespace)) {
        state.revoked = true;
        n++;
      }
    }
    return n;
  }
}
