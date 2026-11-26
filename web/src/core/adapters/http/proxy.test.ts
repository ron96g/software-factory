import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Regression: importing npm undici (e.g. via @kubernetes/client-node) before the first fetch used to drop the env proxy.
test("fetch goes through HTTPS_PROXY even when undici was imported first", async () => {
  const seen: string[] = [];
  const proxy = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.end("via-proxy");
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const keys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.HTTP_PROXY = url;
  try {
    await import("@kubernetes/client-node");
    const { ensureProxyDispatcher, proxyDispatcherActive, describeProxy } = await import("./proxy.ts");
    assert.equal(ensureProxyDispatcher(), url);
    const body = await (await fetch("http://model.example.invalid/v1/models")).text();
    assert.equal(body, "via-proxy");
    assert.deepEqual(seen, ["http://model.example.invalid/v1/models"]);
    assert.equal(proxyDispatcherActive(), true);
    assert.equal(describeProxy(), `via proxy http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    proxy.close();
  }
});
