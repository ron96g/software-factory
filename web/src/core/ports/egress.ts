/**
 * ADR-0080 §7 / SEC-5: the egress proxy. Agent-initiated HTTP goes through the factory, which enforces a per-run
 * allowlist and records what was requested, instead of letting a tool fetch anything from the factory process (or,
 * later, from inside the runtime). It is also the component that will enforce `SandboxProfile.spec.network`.
 */
import type { Ref } from "../model/resource.ts";

export interface EgressRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface EgressResponse {
  status: number;
  contentType?: string;
  body: string;
  bytes: number;
  truncated: boolean;
}

/** Who made the request, for the audit record. */
export interface EgressActor {
  run?: Ref;
  agent?: string;
  namespace?: string;
}

/**
 * An allowlist of hosts (ADR-0080 §7). Empty = deny all. An entry `.example.com` allows `example.com` and any subdomain;
 * a plain `example.com` allows only that host.
 */
export interface EgressPolicy {
  allow: readonly string[];
}

/** Fetches a URL on behalf of a run, after checking the policy. */
export interface EgressProxy {
  fetch(req: EgressRequest, actor: EgressActor): Promise<EgressResponse>;
}

/** A refused egress request, with a machine-readable reason for the audit record. */
export class EgressDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
