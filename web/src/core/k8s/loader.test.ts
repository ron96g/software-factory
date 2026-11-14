import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionStore } from "../store/composite-store.ts";
import { GoneError, K8sLoader, type RestPort, type WatchMsg } from "./loader.ts";
import { selectDefinitionLoader } from "./select.ts";
import type { Resource } from "../model/resource.ts";

const agent = (name: string, ns = "a", rv = "1"): Resource =>
  ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "Agent", metadata: { name, namespace: ns, resourceVersion: rv }, spec: {} }) as unknown as Resource;

function fake(script: Array<() => AsyncIterable<WatchMsg>>, lists: Resource[][]): RestPort & { rvs: string[]; lists: number } {
  let w = 0;
  let l = 0;
  const f = {
    rvs: [] as string[],
    lists: 0,
    async list() {
      f.lists++;
      return { items: lists[Math.min(l++, lists.length - 1)], resourceVersion: `L${l}` };
    },
    watch(rv: string, signal: AbortSignal) {
      f.rvs.push(rv);
      const s = script[w++];
      if (!s) return (async function* () { await new Promise((r) => signal.addEventListener("abort", r)); })();
      return s();
    },
  };
  return f;
}
const until = async (c: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!c()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("AC-1 create/update/delete reflected within 5s with events; bulk initial list", async () => {
  const rest = fake([async function* () {
    yield { type: "ADDED", object: agent("n", "b", "2") };
    yield { type: "MODIFIED", object: agent("n", "b", "3") };
    yield { type: "DELETED", object: agent("x", "a", "4") };
  }], [[agent("x")]]);
  const loader = new K8sLoader(rest, { sleep: async () => {} });
  const store = await new DefinitionStore(loader).init();
  assert.equal((await store.list("Agent")).length, 1);
  const ev: string[] = [];
  store.watch((e) => ev.push(e.type));
  const t0 = Date.now();
  loader.start(store);
  await until(() => ev.length === 3);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(ev, ["ADDED", "MODIFIED", "DELETED"]);
  assert.equal(rest.rvs[0], "L1");
  assert.equal((await store.list("Agent")).length, 1);
  await loader.stop();
});

test("AC-2 reconnects with backoff from last resourceVersion, relists on 410", async () => {
  const sleeps: number[] = [];
  const rest = fake([
    async function* () { yield { type: "ADDED", object: agent("n", "a", "5") }; throw new Error("drop"); },
    async function* () { throw new GoneError(); },
  ], [[agent("x")], [agent("y")]]);
  const loader = new K8sLoader(rest, { sleep: async (m) => void sleeps.push(m) });
  const store = await new DefinitionStore(loader).init();
  loader.start(store);
  await until(() => rest.lists >= 2 && rest.rvs.length >= 3);
  assert.equal(rest.rvs[1], "5");
  assert.ok(sleeps.length >= 1);
  const names = (await store.list("Agent")).map((r) => r.metadata.name);
  assert.deepEqual(names.sort(), ["y"]);
  assert.equal(rest.rvs[2], "L2");
  await loader.stop();
});

test("AC-1 loader selection by KUBERNETES_SERVICE_HOST", () => {
  const git = { load: async () => [] };
  const rest = fake([], [[]]);
  assert.ok(selectDefinitionLoader({ KUBERNETES_SERVICE_HOST: "h" }, () => git, () => rest) instanceof K8sLoader);
  assert.equal(selectDefinitionLoader({}, () => git, () => rest), git);
});
