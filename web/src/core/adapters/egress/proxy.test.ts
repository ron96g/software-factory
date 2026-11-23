import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultEgressProxy, hostAllowed } from "./proxy.ts";
import { EgressDeniedError } from "../../ports/index.ts";

test("P0-9: the egress proxy fetches an allowlisted host and returns the body", async () => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  const proxy = new DefaultEgressProxy({ policy: { allow: [".example.com"] }, fetch: f });
  const r = await proxy.fetch({ url: "https://docs.example.com/a" }, {});
  assert.equal(r.status, 200);
  assert.equal(r.body, "hello");
  assert.equal(r.contentType, "text/plain");
  assert.deepEqual(calls, ["https://docs.example.com/a"]);
});

test("P0-9: a host off the allowlist is refused", async () => {
  const ok = (async () => Response.json({})) as unknown as typeof fetch;
  await assert.rejects(
    new DefaultEgressProxy({ policy: { allow: [".example.com"] }, fetch: ok }).fetch({ url: "https://evil.test/x" }, {}),
    (e: unknown) => e instanceof EgressDeniedError && e.reason === "not-allowed",
  );
  // A plain entry allows only that host, not its subdomains.
  const exact = new DefaultEgressProxy({ policy: { allow: ["example.com"] }, fetch: ok });
  await assert.rejects(exact.fetch({ url: "https://sub.example.com/x" }, {}), /not on the egress allowlist/);
  await exact.fetch({ url: "https://example.com/x" }, {});
});

test("P0-9: plain http is refused except on loopback, and redirects are never followed", async () => {
  const seen: RequestInit[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response("ok");
  }) as unknown as typeof fetch;
  const proxy = new DefaultEgressProxy({ policy: { allow: ["example.com", "localhost"] }, fetch: f });
  await assert.rejects(proxy.fetch({ url: "http://example.com/x" }, {}), (e: unknown) => e instanceof EgressDeniedError && e.reason === "insecure");
  await proxy.fetch({ url: "http://localhost:3000/x" }, {});
  assert.equal(seen[0].redirect, "manual", "a redirect must not become an allowlist bypass");
});

test("P0-9: the response is size-capped and truncated", async () => {
  const f = (async () => new Response("x".repeat(100))) as unknown as typeof fetch;
  const proxy = new DefaultEgressProxy({ policy: { allow: ["example.com"] }, fetch: f, maxBytes: 10 });
  const r = await proxy.fetch({ url: "https://example.com/big" }, {});
  assert.equal(r.bytes, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.body.length, 10);
});

test("P0-9: hostAllowed matches domains and subdomains, and denies everything by default", () => {
  assert.equal(hostAllowed("docs.example.com", [".example.com"]), true);
  assert.equal(hostAllowed("example.com", [".example.com"]), true);
  assert.equal(hostAllowed("example.com", ["example.com"]), true);
  assert.equal(hostAllowed("sub.example.com", ["example.com"]), false);
  assert.equal(hostAllowed("example.com", []), false);
});
