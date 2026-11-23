import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultModelProxy } from "./model-proxy.ts";
import { InMemoryModelTokens } from "../adapters/model-proxy/tokens.ts";
import { createModelProxyHttpHandler } from "../adapters/model-proxy/http.ts";
import { ModelUnavailableError, type ModelProxyGrant, type ModelResolver } from "../ports/index.ts";

const grant = (over: Partial<ModelProxyGrant> = {}): ModelProxyGrant => ({
  run: { name: "run-1", namespace: "default" },
  namespace: "default",
  providerRef: { name: "openai" },
  tier: "coding",
  models: ["gpt-x"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

const resolver: ModelResolver = {
  resolve: async () => ({
    provider: "openai", providerType: "openai-compatible", model: "gpt-x", tier: "coding",
    client: { complete: async () => "" },
    endpoint: { type: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "sk-provider-secret" },
  }),
};

function provider(o: { status?: number; retryAfter?: string } = {}) {
  const calls: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
    if (o.status) return new Response("nope", { status: o.status, headers: o.retryAfter ? { "retry-after": o.retryAfter } : {} });
    return Response.json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("X60: the proxy holds the key, forwards to the provider, and charges usage to the run token", async () => {
  const tokens = new InMemoryModelTokens();
  const { fetchImpl, calls } = provider();
  const proxy = new DefaultModelProxy({ tokens, models: resolver, fetch: fetchImpl });
  const t = await tokens.issue(grant());

  const result = await proxy.chatCompletions(t.token, { model: "gpt-x", messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls[0].url, "https://provider.test/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer sk-provider-secret", "the provider key is used by the proxy, never by the caller");
  assert.equal(calls[0].body.model, "gpt-x");
  assert.equal(result.usage?.totalTokens, 15);
  assert.deepEqual((await tokens.verify(t.token))!.calls, 1);
  assert.deepEqual((await tokens.verify(t.token))!.tokens, 15);
});

test("X60: the proxy refuses unknown, revoked and expired tokens (401)", async () => {
  let now = Date.now();
  const tokens = new InMemoryModelTokens(() => new Date(now));
  const proxy = new DefaultModelProxy({ tokens, models: resolver, fetch: provider().fetchImpl });

  await assert.rejects(proxy.chatCompletions("sfm_nope", { model: "gpt-x", messages: [] }), /unknown, revoked or expired/);

  const t = await tokens.issue(grant());
  await tokens.revoke(t.token);
  await assert.rejects(proxy.chatCompletions(t.token, { model: "gpt-x", messages: [] }), /unknown, revoked or expired/);

  const short = await tokens.issue(grant({ expiresAt: new Date(now + 1000).toISOString() }));
  now += 5000;
  await assert.rejects(proxy.chatCompletions(short.token, { model: "gpt-x", messages: [] }), /unknown, revoked or expired/);
});

test("X60: the proxy enforces the model allowlist and the step budget", async () => {
  const tokens = new InMemoryModelTokens();
  const proxy = new DefaultModelProxy({ tokens, models: resolver, fetch: provider().fetchImpl });

  const t = await tokens.issue(grant({ models: ["gpt-x"] }));
  await assert.rejects(proxy.chatCompletions(t.token, { model: "gpt-other", messages: [] }), /not allowed/);

  const capped = await tokens.issue(grant({ maxCalls: 1 }));
  await proxy.chatCompletions(capped.token, { model: "gpt-x", messages: [] });
  await assert.rejects(proxy.chatCompletions(capped.token, { model: "gpt-x", messages: [] }), /step budget/);
});

test("X60: a provider quota error is a wait, not a failure (ADR-0031)", async () => {
  const tokens = new InMemoryModelTokens();
  const proxy = new DefaultModelProxy({ tokens, models: resolver, fetch: provider({ status: 429, retryAfter: "30" }).fetchImpl });
  const t = await tokens.issue(grant());
  await assert.rejects(proxy.chatCompletions(t.token, { model: "gpt-x", messages: [] }), (e: unknown) => e instanceof ModelUnavailableError && e.status === 429 && e.retryAfterMs === 30_000);
});

test("X60: revokeRun revokes every token bound to the run", async () => {
  const tokens = new InMemoryModelTokens();
  const a = await tokens.issue(grant());
  const b = await tokens.issue(grant());
  const other = await tokens.issue(grant({ run: { name: "run-2", namespace: "default" } }));
  assert.equal(await tokens.revokeRun({ name: "run-1", namespace: "default" }), 2);
  assert.equal(await tokens.verify(a.token), undefined);
  assert.equal(await tokens.verify(b.token), undefined);
  assert.ok(await tokens.verify(other.token));
});

test("X60: the HTTP surface requires the token and maps refusals to statuses", async () => {
  const tokens = new InMemoryModelTokens();
  const handler = createModelProxyHttpHandler({ proxy: new DefaultModelProxy({ tokens, models: resolver, fetch: provider().fetchImpl }) });
  const url = "http://127.0.0.1:3000/api/model-proxy/v1/chat/completions";
  const body = JSON.stringify({ model: "gpt-x", messages: [] });

  assert.equal((await handler(new Request(url, { method: "POST", body }))).status, 401);

  const t = await tokens.issue(grant({ models: ["gpt-x"] }));
  const ok = await handler(new Request(url, { method: "POST", headers: { authorization: `Bearer ${t.token}` }, body }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { choices: unknown[] }).choices.length, 1);

  const forbidden = await handler(new Request(url, { method: "POST", headers: { authorization: `Bearer ${t.token}` }, body: JSON.stringify({ model: "gpt-other", messages: [] }) }));
  assert.equal(forbidden.status, 403);
});
