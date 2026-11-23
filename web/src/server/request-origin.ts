/**
 * S0-4 (SEC-16): the factory is a local tool with no authentication yet (ADR-0009), so the browser
 * session that operates it is a surface we must protect. A browser attaches `Origin` (and, in modern
 * browsers, `Sec-Fetch-Site`) to a state-changing request; a page on another origin must not be able
 * to drive the factory's API. This is a CSRF guard for the *browser*, not a boundary against a
 * non-browser client — the sandbox path is closed separately (SEC-15, `docs/security.md` §7).
 *
 * Kept as a pure function (no Next.js import) so the policy is unit-testable on its own.
 */
export interface OriginCheckInput {
  method: string;
  /** The request `Origin` header, when present. */
  origin?: string | null;
  /** Effective request host: `x-forwarded-host` if a proxy set it, else `Host`. Includes the port. */
  host?: string | null;
  /** The `Sec-Fetch-Site` header, when the browser sent it. */
  secFetchSite?: string | null;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when a state-changing request is attributable to a different origin than the app itself. */
export function isCrossOriginRequest(input: OriginCheckInput): boolean {
  if (!STATE_CHANGING.has(input.method.toUpperCase())) return false;
  // The browser tells us directly when it can; trust that first.
  if (input.secFetchSite?.trim().toLowerCase() === "cross-site") return true;
  const origin = input.origin?.trim();
  // No Origin header: a non-browser client (CLI, MCP harness, the factory's own server-side fetch).
  // Browsers always send it on state-changing requests, so there is nothing to attribute here.
  if (!origin) return false;
  // An opaque origin ("null"): a sandboxed frame or a file:// page. Never same-origin.
  if (origin === "null") return true;
  const host = input.host?.trim();
  if (!host) return true; // an Origin we cannot compare against the request is not one we accept
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // malformed Origin
  }
}
