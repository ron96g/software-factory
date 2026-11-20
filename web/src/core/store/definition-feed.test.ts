import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClusterApi } from "../adapters/kubernetes/fake-cluster-api.ts";
import { FeedDefinitionLoader, KubernetesDefinitionFeed, definitionsBackend } from "./definition-feed.ts";
import { DefinitionStore } from "./composite-store.ts";

function fixture() {
  const api = new FakeClusterApi();
  api.set("agents", [{ metadata: { name: "dev", namespace: "sf", uid: "u1", resourceVersion: "42" }, spec: { body: "  hello \n", tier: "fast" } }]);
  api.set("workflows", [{ metadata: { name: "wf", uid: "u2", resourceVersion: "7" }, spec: { stages: [] } }]);
  return api;
}

test("AC-2: CRs map to Resources with uid, resourceVersion and body lifted out of spec", async () => {
  const feed = new KubernetesDefinitionFeed(fixture(), { sf: "factory-system" });
  const { resources } = await feed.list();
  const agent = resources.find((r) => r.kind === "Agent") as any;
  assert.equal(agent.metadata.uid, "u1");
  assert.equal(agent.metadata.resourceVersion, "42");
  assert.equal(agent.metadata.namespace, "factory-system");
  assert.equal(agent.body, "hello");
  assert.equal(agent.spec.body, undefined);
  assert.equal(agent.spec.tier, "fast");
  const wf = resources.find((r) => r.kind === "Workflow")!;
  assert.equal(wf.metadata.namespace, "factory-system");
  assert.equal((wf as any).body, undefined);
});

test("AC-1: definition store serves cluster definitions through the feed loader", async () => {
  const store = await new DefinitionStore(new FeedDefinitionLoader(new KubernetesDefinitionFeed(fixture()))).init();
  assert.ok(await store.get("Agent", "sf", "dev"));
  assert.equal((await store.list("Workflow")).length, 1);
});

test("list failure surfaces as an error", async () => {
  const api = fixture();
  api.failWith = new Error("unreachable");
  await assert.rejects(new KubernetesDefinitionFeed(api).list(), /unreachable/);
});

test("AC-1/AC-9: FACTORY_DEFINITIONS_BACKEND selects the backend, old name stays an alias, git is the default", () => {
  assert.equal(definitionsBackend({}), "git");
  assert.equal(definitionsBackend({ FACTORY_DEFINITIONS_BACKEND: "kubernetes" }), "kubernetes");
  assert.equal(definitionsBackend({ FACTORY_DEFINITION_SOURCE: "kubernetes" }), "kubernetes");
  assert.equal(definitionsBackend({ FACTORY_DEFINITIONS_BACKEND: "git", FACTORY_DEFINITION_SOURCE: "kubernetes" }), "git");
  assert.throws(() => definitionsBackend({ FACTORY_DEFINITIONS_BACKEND: "etcd" }), /must be "git" or "kubernetes"/);
});
