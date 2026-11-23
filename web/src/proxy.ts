import { NextResponse, type NextRequest } from "next/server";
import { isCrossOriginRequest } from "./server/request-origin.ts";

/**
 * S0-4 (SEC-16): reject cross-origin state-changing API requests. The factory has no authentication
 * yet (ADR-0009), so a page on another origin must not be able to approve a gate, publish a ticket,
 * or create an issue through the operator's browser. Same-origin callers (the UI, the factory's own
 * server-side fetch, a CLI/MCP harness without an Origin header) are unaffected.
 */
export function proxy(request: NextRequest): NextResponse {
  const crossOrigin = isCrossOriginRequest({
    method: request.method,
    origin: request.headers.get("origin"),
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (crossOrigin) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
