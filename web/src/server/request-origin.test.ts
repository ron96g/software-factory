import assert from "node:assert/strict";
import { test } from "node:test";
import { isCrossOriginRequest } from "./request-origin.ts";
import { contentSecurityPolicy, securityHeaders } from "./security-headers.ts";

// `proxy.ts` is a thin adapter over `isCrossOriginRequest` (it only reads headers and returns 403),
// so the policy is covered here; the adapter itself is exercised through the app's HTTP surface.

test("S0-4 (SEC-16): a same-origin POST is allowed", () => {
  assert.equal(
    isCrossOriginRequest({ method: "POST", origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }),
    false,
  );
  assert.equal(
    isCrossOriginRequest({ method: "POST", origin: "http://localhost:3000", host: "localhost:3000", secFetchSite: "same-origin" }),
    false,
  );
});

test("S0-4 (SEC-16): a cross-origin POST is rejected", () => {
  assert.equal(
    isCrossOriginRequest({ method: "POST", origin: "http://evil.example", host: "127.0.0.1:3000" }),
    true,
  );
  // A different port on the same host is a different origin.
  assert.equal(
    isCrossOriginRequest({ method: "DELETE", origin: "http://127.0.0.1:4000", host: "127.0.0.1:3000" }),
    true,
  );
});

test("S0-4 (SEC-16): Sec-Fetch-Site cross-site is rejected even without a usable Origin", () => {
  assert.equal(isCrossOriginRequest({ method: "POST", secFetchSite: "cross-site" }), true);
  assert.equal(isCrossOriginRequest({ method: "POST", origin: "null", host: "127.0.0.1:3000" }), true);
});

test("S0-4 (SEC-16): safe methods and header-less clients are left alone", () => {
  assert.equal(isCrossOriginRequest({ method: "GET", origin: "http://evil.example", host: "127.0.0.1:3000" }), false);
  assert.equal(isCrossOriginRequest({ method: "POST" }), false);
});

test("S0-4 (SEC-16): the CSP locks down plugins, framing and base, and allows the app's own assets", () => {
  const prod = contentSecurityPolicy(false);
  assert.match(prod, /object-src 'none'/);
  assert.match(prod, /frame-ancestors 'none'/);
  assert.match(prod, /base-uri 'self'/);
  assert.match(prod, /default-src 'self'/);
  assert.doesNotMatch(prod, /unsafe-eval/);
  assert.match(contentSecurityPolicy(true), /unsafe-eval/);
  assert.ok(securityHeaders(false).some((h) => h.key === "Content-Security-Policy"));
  assert.ok(securityHeaders(false).some((h) => h.key === "X-Content-Type-Options"));
});
