import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactory } from "./factory.ts";
import { FakeClusterApi } from "./adapters/kubernetes/fake-cluster-api.ts";
import { KubernetesDefinitionFeed } from "./store/definition-feed.ts";
import type { WatchEvent } from "./ports/index.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = (name: string, rv: string, extra: Record<string, unknown> = {}) => ({ metadata: { name, namespace: "factory-system", uid: `u-${name}`, resourceVersion: rv }, spec: { role: "r", body: "x", ...extra } });

async function build(env: Record<string, string>, api = new FakeClusterApi()) {
  const reads: string[] = [];
  const feed = new KubernetesDefinitionFeed(api);
  const f = await createFactory({
    databasePath: ":memory:",
    localRoot: mkdtempSync(join(tmpdir(), "sf-k8s-")),
    definitionFeed: feed,
    secretReader: { readSecrets: async (ns) => { reads.push(ns); return {}; } },
    env: { FACTORY_AGENT_RUNTIME: "tool-loop", ...env },
    log: () => {},
  });
  return { f, api, reads };
}

test("AC-1/AC-7/AC-11: kubernetes mode needs no definitionsRoot and reads secrets from the trusted namespace", async () => {
  const api = new FakeClusterApi();
  api.set("agents", [agent("a", "1")]);
  const { f, reads } = await build({ FACTORY_DEFINITION_SOURCE: "kubernetes", FACTORY_SECRET_NAMESPACE: "trusted" }, api);
  assert.deepEqual(reads, ["trusted"]);
  await f.stop();
});

test("kubernetes mode requires a secret namespace; unknown source is rejected", async () => {
  await assert.rejects(build({ FACTORY_DEFINITION_SOURCE: "kubernetes" }), /FACTORY_SECRET_NAMESPACE/);
  await assert.rejects(build({ FACTORY_DEFINITION_SOURCE: "etcd" }), /FACTORY_DEFINITION_SOURCE/);
});

test("AC-5/AC-8: a bad snapshot records a Warning; a good change refreshes derived caches", async () => {
  const api = new FakeClusterApi();
  api.set("agents", [agent("a", "1")]);
  const { f, reads } = await build({ FACTORY_DEFINITION_SOURCE: "kubernetes", FACTORY_SECRET_NAMESPACE: "trusted" }, api);
  const warnings: WatchEvent[] = [];
  f.watcher.watch((e) => { if (e.object.kind === "Event" && (e.object.spec as any)?.reason === "DefinitionsRejected") warnings.push(e); });
  const before = reads.length;
  api.change("agents", [agent("a", "2", { skillRefs: [{ name: "missing-skill" }] })]);
  await wait(1500);
  assert.ok(warnings.length >= 1, "DefinitionsRejected warning recorded");
  assert.equal(reads.length, before, "rejected snapshot does not reload caches");
  api.change("agents", [agent("a", "3"), agent("b", "1")]);
  await wait(1500);
  assert.ok(reads.length > before, "secrets refreshed after a good reload");
  await f.stop();
});
