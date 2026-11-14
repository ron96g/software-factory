import { test } from "node:test";
import assert from "node:assert/strict";
import { AdmissionChain, } from "./chain.ts";
import { nameValidator, refValidator } from "./builtins.ts";
import { snapshotAdmit } from "./snapshot.ts";
import { DefinitionStore } from "../store/composite-store.ts";
import type { Resource } from "../model/resource.ts";

const skill = (name: string, ns = "a"): Resource => ({ apiVersion: "v1", kind: "Skill", metadata: { name, namespace: ns }, spec: {} }) as Resource;
const agent = (name: string, skillName: string, ns = "a"): Resource =>
  ({ apiVersion: "v1", kind: "Agent", metadata: { name, namespace: ns }, spec: { skillRefs: [{ name: skillName }] } }) as Resource;

async function store() {
  const chain = new AdmissionChain();
  chain.addValidator(nameValidator());
  chain.addValidator(refValidator());
  return new DefinitionStore({ load: async () => [] }, snapshotAdmit(chain)).init();
}

test("real chain rejects invalid name", async () => {
  const s = await store();
  assert.equal((await s.apply(skill("Bad_Name"))).ok, false);
  assert.equal(s.snapshotVersion, 0);
});

test("real chain rejects dangling reference, accepts resolvable one", async () => {
  const s = await store();
  assert.equal((await s.apply(agent("ag", "sk"))).ok, false);
  assert.ok((await s.apply(skill("sk"))).ok);
  assert.ok((await s.apply(agent("ag", "sk"))).ok);
  // unqualified ref does not resolve across namespaces
  assert.equal((await s.apply(agent("ag2", "sk", "b"))).ok, false);
});

test("real chain rejects removal of referenced skill", async () => {
  const s = await store();
  await s.apply(skill("sk"));
  await s.apply(agent("ag", "sk"));
  assert.equal((await s.remove("Skill", "a", "sk")).ok, false);
  assert.ok(await s.get("Skill", "a", "sk"));
});

test("AC-5 same name in two namespaces coexist; ns/name resolves explicitly", async () => {
  const s = await store();
  await s.apply(skill("sk", "a"));
  await s.apply(skill("sk", "b"));
  assert.ok((await s.apply(agent("dev", "sk", "a"))).ok);
  assert.ok((await s.apply(agent("dev", "sk", "b"))).ok);
  assert.ok(await s.get("Agent", "a", "dev"));
  assert.ok(await s.get("Agent", "b", "dev"));
  assert.ok((await s.apply(agent("x", "b/sk", "a"))).ok);
  assert.equal((await s.apply(agent("y", "c/sk", "a"))).ok, false);
});

test("snapshots retained until last pin released; count metric", async () => {
  const s = await store();
  await s.apply(skill("sk"));
  const v = s.acquireSnapshot();
  const v2 = s.acquireSnapshot();
  await s.apply(skill("sk2"));
  assert.equal(s.snapshotCount, 2);
  assert.equal(s.snapshot(v)?.length, 1);
  s.releaseSnapshot(v);
  assert.equal(s.snapshot(v)?.length, 1);
  s.releaseSnapshot(v2);
  assert.equal(s.snapshot(v), undefined);
  assert.equal(s.snapshotCount, 1);
});
