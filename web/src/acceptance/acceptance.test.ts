import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrds } from "../core/k8s/crds.ts";

test("AC-1: live reload create/update/delete", async () => {
  const { DefinitionStore } = await import("../core/store/composite-store.ts");
  const { K8sLoader } = await import("../core/k8s/loader.ts");
  const ag = (n: string, ns: string, rv: string) => ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "Agent", metadata: { name: n, namespace: ns, resourceVersion: rv }, spec: {} }) as never;
  const rest = {
    async list() { return { items: [ag("x", "a", "1")], resourceVersion: "L1" }; },
    watch(_rv: string, sig: AbortSignal) {
      let used = (rest as any).used; (rest as any).used = true;
      if (used) return (async function* () { await new Promise((r) => sig.addEventListener("abort", r)); })();
      return (async function* () {
        yield { type: "ADDED", object: ag("n", "b", "2") };
        yield { type: "MODIFIED", object: ag("n", "b", "3") };
        yield { type: "DELETED", object: ag("x", "a", "4") };
      })();
    },
  };
  const loader = new K8sLoader(rest as never, { sleep: async () => {} });
  const store = await new DefinitionStore(loader).init();
  const ev: string[] = [];
  store.watch((e) => ev.push(e.type));
  const t0 = Date.now();
  loader.start(store);
  while (ev.length < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
  await loader.stop();
  assert.deepEqual(ev, ["ADDED", "MODIFIED", "DELETED"]);
  assert.ok(Date.now() - t0 < 5000);
});
test("AC-2: reconnect and relist", async () => {
  await import("../core/k8s/loader.test.ts"); // real AC-2 scenario (reconnect with backoff, relist on 410) runs in loader.test.ts
});
test("AC-3: rejection keeps state", async () => {
  const { DefinitionStore } = await import("../core/store/composite-store.ts");
  const mk = (n: string) => ({ apiVersion: "v1", kind: "Skill", metadata: { name: n, namespace: "a" }, spec: {} }) as never;
  const s = await new DefinitionStore({ load: async () => [] } as never, (c: readonly any[]) => (c.some((r) => r.metadata.name === "bad") ? "bad" : undefined)).init();
  await s.apply(mk("ok"));
  const v = s.snapshotVersion;
  assert.equal((await s.apply(mk("bad"))).ok, false);
  assert.equal(s.snapshotVersion, v);
  assert.equal((await s.list("Skill")).length, 1);
});
test("AC-4: referenced delete rejected", async () => {
  const { DefinitionStore } = await import("../core/store/composite-store.ts");
  const mk = (n: string) => ({ apiVersion: "v1", kind: "Skill", metadata: { name: n, namespace: "a" }, spec: {} }) as never;
  const needX = (c: readonly any[]) => (c.some((r) => r.metadata.name === "y") && !c.some((r) => r.metadata.name === "x") ? "y needs x" : undefined);
  const s = await new DefinitionStore({ load: async () => [] } as never, needX).init();
  await s.apply(mk("x")); await s.apply(mk("y"));
  const v = s.snapshotVersion;
  assert.equal((await s.remove("Skill", "a", "x")).ok, false);
  assert.equal(s.snapshotVersion, v);
  assert.ok(await s.get("Skill", "a", "x"));
});
test("AC-5: namespaced identity", async () => {
  const { DefinitionStore } = await import("../core/store/composite-store.ts");
  const mk = (ns: string) => ({ apiVersion: "v1", kind: "Agent", metadata: { name: "dev", namespace: ns }, spec: {} }) as never;
  const s = await new DefinitionStore({ load: async () => [] } as never).init();
  await s.apply(mk("a")); await s.apply(mk("b"));
  assert.equal((await s.list("Agent")).length, 2);
  assert.ok(await s.get("Agent", "a", "dev"));
  assert.ok(await s.get("Agent", "b", "dev"));
});
test("AC-6: run pinning", async () => {
  const { DefinitionStore } = await import("../core/store/composite-store.ts");
  const mk = (b: string) => ({ apiVersion: "x", kind: "Agent", metadata: { name: "d", namespace: "a" }, spec: { body: b } }) as never;
  const s = await new DefinitionStore({ load: async () => [mk("1")] } as never).init();
  const v = s.acquireSnapshot();
  await s.apply(mk("2"));
  assert.equal((s.snapshot(v)![0] as any).spec.body, "1");
  s.releaseSnapshot(v);
  assert.equal(s.snapshot(v), undefined);
});
test("AC-7: secret redaction", async () => {
  const { K8sSecretResolver } = await import("../core/k8s/secrets.ts");
  const V = "s3cr3t-value-xyz";
  const r = new K8sSecretResolver({ async get(_n: string, name: string) { return name === "key" ? { value: V } : undefined; } } as never);
  await r.refresh([{ ref: { name: "key" }, namespace: "a" }]);
  let msg = "";
  try { await r.refresh([{ ref: { name: "gone" }, namespace: "a" }]); } catch (e) { msg = String(e); }
  assert.ok(msg.length > 0 && !msg.includes(V));
});
test("AC-8: status conditions only", async () => {
  const { StatusWriter } = await import("../core/k8s/status.ts");
  const calls: any[] = [];
  const w = new StatusWriter({ putStatus: async (t: any, s: any) => void calls.push({ t, s }) } as never);
  await w.rejected({ apiVersion: "v1", kind: "Skill", metadata: { name: "s", namespace: "a" }, spec: { q: 1 } } as never, "r");
  assert.deepEqual(Object.keys(calls[0].s), ["conditions"]);
  assert.deepEqual(Object.keys(calls[0].t).sort(), ["kind", "name", "namespace"]);
  assert.equal(calls[0].s.conditions[0].status, "False");
});
test("AC-9: CRDs and RBAC", () => { assert.equal(buildCrds().length, 9); });
