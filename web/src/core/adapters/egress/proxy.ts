import { EgressDeniedError, type EgressActor, type EgressPolicy, type EgressProxy, type EgressRequest, type EgressResponse } from "../../ports/index.ts";

type Fetch = typeof fetch;

export interface EgressProxyOptions {
  /** The host allowlist (ADR-0080 §7). Empty = deny all. */
  policy: EgressPolicy;
  fetch?: Fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** True when `host` is allowed by an entry: `.example.com` allows the domain and its subdomains; `example.com` only itself. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((entry) => {
    const a = entry.trim().toLowerCase();
    if (!a) return false;
    return a.startsWith(".") ? h === a.slice(1) || h.endsWith(a) : h === a;
  });
}

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";

/**
 * ADR-0080 §7 / SEC-5: a factory-side egress proxy. It refuses anything not on the allowlist, requires https (loopback
 * excepted for local tooling), does not follow redirects (a redirect must not become an allowlist bypass), and caps the
 * response size and time. Every decision is left to the caller to record (the harness writes a transcript note).
 */
export class DefaultEgressProxy implements EgressProxy {
  private readonly policy: EgressPolicy;
  private readonly f: Fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(o: EgressProxyOptions) {
    this.policy = o.policy;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxBytes = o.maxBytes ?? 1_000_000;
  }

  async fetch(req: EgressRequest, _actor: EgressActor): Promise<EgressResponse> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new EgressDeniedError("bad-url", `not a URL: ${req.url}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new EgressDeniedError("insecure", `only https is allowed (ADR-0080 §7): ${req.url}`);
    }
    if (!hostAllowed(url.hostname, this.policy.allow)) {
      throw new EgressDeniedError("not-allowed", `host "${url.hostname}" is not on the egress allowlist (ADR-0080 §7)`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.f(url, {
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual", // never follow a redirect: it could leave the allowlist
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const truncated = buf.length > this.maxBytes;
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        body: buf.subarray(0, this.maxBytes).toString("utf8"),
        bytes: buf.length,
        truncated,
      };
    } catch (e) {
      throw new EgressDeniedError("failed", `egress request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
