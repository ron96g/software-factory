import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionStore } from "./composite-store.ts";
import type { Resource } from "../model/resource.ts";

const mk = (name: string, ns = "a"): Resource => ({ apiVersion: "v1", kind: "Skill", metadata: { name, namespace: ns }, spec: {} }) as Resource;
const bad = (c: readonly Resource[]) => (c.some((r) => r.metadata.name === "bad") ? "bad" : undefined);
const noX = (c: readonly Resource[]) => (c.some((r) => r.metadata.name === "x") ? undefined : c.some((r) => r.metadata.name === "y") ? "y needs x" : undefined);

test("apply/remove emit events; rejection keeps state", async () => {
  const s = await new DefinitionStore({ load: async () => [] }, bad).init();
  const ev: string[] = [];
  s.watch((e) => ev.push(e.type));
  assert.ok((await s.apply(mk("x"))).ok);
  assert.ok((await s.apply(mk("x", "b"))).ok);
  assert.equal((await s.list("Skill")).length, 2);
  assert.ok((await s.apply(mk("x"))).ok);
  assert.equal((await s.apply(mk("bad"))).ok, false);
  assert.ok((await s.remove("Skill", "a", "x")).ok);
  assert.deepEqual(ev, ["ADDED", "ADDED", "MODIFIED", "DELETED"]);
  assert.equal(s.snapshotVersion, 4);
});

test("rejected apply/remove emit nothing and keep version", async () => {
  const s = await new DefinitionStore({ load: async () => [] }, noX).init();
  await s.apply(mk("x"));
  await s.apply(mk("y"));
  const ev: string[] = [];
  s.watch((e) => ev.push(e.type));
  const v = s.snapshotVersion;
  assert.equal((await s.remove("Skill", "a", "x")).ok, false);
  assert.equal((await s.apply(mk("bad2"))).ok, true);
  assert.equal((await s.get("Skill", "a", "x"))?.metadata.name, "x");
  const s2 = await new DefinitionStore({ load: async () => [] }, bad).init();
  s2.watch((e) => ev.push(e.type));
  await s2.apply(mk("bad"));
  assert.equal(s2.snapshotVersion, 0);
  assert.deepEqual(ev, ["ADDED"]);
  assert.equal(s.snapshotVersion, v + 1);
});

test("throwing listener does not block others", async () => {
  const s = await new DefinitionStore({ load: async () => [] }).init();
  let got = 0;
  s.watch(() => { throw new Error("boom"); });
  s.watch(() => got++);
  assert.ok((await s.apply(mk("x"))).ok);
  assert.equal(got, 1);
});
