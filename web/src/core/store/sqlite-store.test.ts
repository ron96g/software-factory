import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteStore } from "./sqlite-store.ts";
import { isStoreError } from "../ports/index.ts";
import { ownerRef } from "../model/meta.ts";
import type { Resource } from "../model/resource.ts";

const clock = { now: () => new Date("2026-11-11T00:00:00Z") };
const newStore = () => new SqliteStore(new DatabaseSync(":memory:"), clock);
const obj = (kind: string, name: string, spec: unknown = {}): Resource => ({
  apiVersion: "factory.ai-dlc.io/v1alpha1",
  kind,
  metadata: { name, namespace: "default" },
  spec,
});

test("CRUD with resourceVersion and namespace defaulting", async () => {
  const s = newStore();
  const created = await s.create<Resource>({ ...obj("WorkItem", "a"), metadata: { name: "a" } });
  assert.equal(created.metadata.namespace, "default");
  assert.ok(created.metadata.uid);
  const got = await s.get("WorkItem", "default", "a");
  assert.equal(got?.metadata.resourceVersion, created.metadata.resourceVersion);
  const updated = await s.update({ ...got!, spec: { title: "x" } });
  assert.notEqual(updated.metadata.resourceVersion, created.metadata.resourceVersion);
  assert.equal((await s.list("WorkItem")).length, 1);
  await s.delete("WorkItem", "default", "a");
  assert.equal(await s.get("WorkItem", "default", "a"), null);
});

test("duplicate create → AlreadyExists; generateName", async () => {
  const s = newStore();
  await s.create(obj("WorkItem", "a"));
  await assert.rejects(s.create(obj("WorkItem", "a")), (e) => isStoreError(e, "AlreadyExists"));
  const g = await s.create({ ...obj("Event", ""), metadata: { name: "", generateName: "evt-" } });
  assert.match(g.metadata.name, /^evt-/);
});

test("stale resourceVersion → Conflict", async () => {
  const s = newStore();
  const a = await s.create(obj("WorkItem", "a"));
  await s.update({ ...a, spec: { v: 1 } });
  await assert.rejects(s.update({ ...a, spec: { v: 2 } }), (e) => isStoreError(e, "Conflict"));
});

test("spec/status split", async () => {
  const s = newStore();
  const a = await s.create(obj("WorkItem", "a", { title: "t" }));
  const withStatus = await s.updateStatus({ ...a, spec: { title: "IGNORED" }, status: { phase: "Running" } });
  assert.deepEqual(withStatus.spec, { title: "t" });
  const spec = await s.update({ ...withStatus, spec: { title: "u" }, status: { phase: "IGNORED" } });
  assert.deepEqual(spec.status, { phase: "Running" });
});

test("owner cascade delete", async () => {
  const s = newStore();
  const wi = await s.create(obj("WorkItem", "a"));
  const run = await s.create({ ...obj("AgentRun", "r"), metadata: { name: "r", namespace: "default", ownerReferences: [ownerRef(wi)] } });
  await s.create({ ...obj("Artifact", "x"), metadata: { name: "x", namespace: "default", ownerReferences: [ownerRef(run)] } });
  await s.create(obj("WorkItem", "other"));
  const deleted: string[] = [];
  s.watch((e) => e.type === "DELETED" && deleted.push(e.object.kind));
  await s.delete("WorkItem", "default", "a");
  assert.deepEqual(deleted.sort(), ["AgentRun", "Artifact", "WorkItem"]);
  assert.equal((await s.list("WorkItem")).length, 1);
});

test("list filters: namespace, labels, ownedBy; watch kinds", async () => {
  const s = newStore();
  const seen: string[] = [];
  s.watch((e) => seen.push(e.object.metadata.name), ["WorkItem"]);
  const wi = await s.create({ ...obj("WorkItem", "a"), metadata: { name: "a", labels: { t: "bug" } } });
  await s.create({ ...obj("WorkItem", "b"), metadata: { name: "b", namespace: "squad-x" } });
  await s.create({ ...obj("Event", "e"), metadata: { name: "e", ownerReferences: [ownerRef(wi)] } });
  assert.equal((await s.list("WorkItem", { namespace: "default" })).length, 1);
  assert.equal((await s.list("WorkItem", { labelSelector: { t: "bug" } })).length, 1);
  assert.equal((await s.list("Event", { ownedBy: { kind: "WorkItem", name: "a", namespace: "default" } })).length, 1);
  assert.deepEqual(seen, ["a", "b"]);
});
