import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClusterApi } from "../adapters/kubernetes/fake-cluster-api.ts";
import { KubernetesDefinitionFeed } from "./definition-feed.ts";
import { ReloadingDefinitionStore, refSnapshotValidator } from "./reloading-store.ts";
import { refValidator } from "../admission/builtins.ts";
import type { WatchEvent } from "../ports/index.ts";

const agent = (name: string, rv: string, extra: Record<string, unknown> = {}) => ({ metadata: { name, uid: `u-${name}`, resourceVersion: rv }, spec: { body: "x", ...extra } });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const api = new FakeClusterApi();
  api.set("agents", [agent("a", "1")]);
  const rejected: string[] = [];
  const feed = new KubernetesDefinitionFeed(api);
  const store = new ReloadingDefinitionStore({ feed, validator: refSnapshotValidator([refValidator()]), onRejected: (r) => rejected.push(r), debounceMs: 1 });
  const orig = feed.watch.bind(feed);
  feed.watch = (since, cb) => orig(since, cb, 5);
  await store.init();
  const events: WatchEvent[] = [];
  store.watch((e) => events.push(e));
  return { api, store, events, rejected };
}

test("AC-3: add, modify, delete reload the snapshot and emit watch events", async () => {
  const { api, store, events } = await setup();
  api.change("agents", [agent("a", "2"), agent("b", "1")]);
  await wait();
  await store.settled();
  assert.deepEqual(events.map((e) => `${e.type}:${e.object.metadata.name}`).sort(), ["ADDED:b", "MODIFIED:a"]);
  api.change("agents", [agent("b", "1")]);
  await wait();
  await store.settled();
  assert.ok(events.some((e) => e.type === "DELETED" && e.object.metadata.name === "a"));
  assert.equal(await store.get("Agent", "factory-system", "a"), null);
  store.close();
});

test("AC-4: 410 Gone triggers relist and a fresh watch", async () => {
  const { api, store, events } = await setup();
  api.set("agents", [agent("a", "1"), agent("c", "1")]);
  api.drop("agents");
  await wait(60);
  await store.settled();
  assert.ok(events.some((e) => e.type === "ADDED" && e.object.metadata.name === "c"));
  assert.ok(api.watchStarts.filter((w) => w.plural === "agents").length >= 2);
  store.close();
});

test("AC-5: invalid snapshot keeps the last good one and reports", async () => {
  const { api, store, events, rejected } = await setup();
  api.change("agents", [agent("a", "2"), agent("bad", "1", { skillRefs: [{ name: "missing" }] })]);
  await wait();
  await store.settled();
  assert.equal(events.length, 0);
  assert.equal((await store.get("Agent", "factory-system", "a"))!.metadata.resourceVersion, "1");
  assert.equal(rejected.length, 1);
  store.close();
});

test("AC-6: startup fails fast; outage keeps the last snapshot", async () => {
  const bad = new FakeClusterApi();
  bad.failWith = new Error("unreachable");
  await assert.rejects(new ReloadingDefinitionStore({ feed: new KubernetesDefinitionFeed(bad) }).init(), /unreachable/);
  const { api, store, rejected } = await setup();
  api.failWith = new Error("down");
  api.drop("agents");
  await wait(30);
  await store.settled();
  assert.ok(await store.get("Agent", "factory-system", "a"));
  assert.ok(rejected.some((r) => /down/.test(r)));
  api.failWith = undefined;
  store.close();
});

test("ADR-0011: definitions in any namespace load, but explicit refs to a namespace other than factory-system are rejected", async () => {
  const api = new FakeClusterApi();
  const ns = (o: ReturnType<typeof agent>, namespace: string) => ({ ...o, metadata: { ...o.metadata, namespace } });
  api.set("skills", [ns(agent("s", "1"), "team-a")]);
  api.set("agents", [ns(agent("a", "1", { skillRefs: [{ name: "s", namespace: "team-a" }] }), "team-b")]);
  const store = new ReloadingDefinitionStore({ feed: new KubernetesDefinitionFeed(api), validator: refSnapshotValidator([refValidator()]), debounceMs: 1 });
  await assert.rejects(store.init(), /Skill "s" not found/);
  store.close();
});
