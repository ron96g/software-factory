import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionStore } from "./composite-store.ts";
import { RunPins } from "./run-pins.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { Resource } from "../model/resource.ts";

const skill = (name: string): Resource =>
  ({ apiVersion: "v1", kind: "Skill", metadata: { name, namespace: "a" }, spec: {} }) as Resource;

test("AC-6 run stays pinned, new run uses new, released at last end", async () => {
  const s = await new DefinitionStore({ load: async () => [] }).init();
  const pins = new RunPins(new DatabaseSync(":memory:"), s);
  await s.apply(skill("one"));
  const v1 = pins.start("r1");
  await s.apply(skill("two"));
  const v2 = pins.start("r2");
  assert.notEqual(v1, v2);
  assert.equal(s.snapshot(pins.versionOf("r1")!)?.length, 1);
  assert.equal(s.snapshot(pins.versionOf("r2")!)?.length, 2);
  pins.end("r1");
  assert.equal(s.snapshot(v1), undefined);
  assert.equal(pins.versionOf("r1"), undefined);
});

test("AC-6 restart re-pins unfinished runs to current definitions", async () => {
  const db = new DatabaseSync(":memory:");
  const s1 = await new DefinitionStore({ load: async () => [] }).init();
  await s1.apply(skill("one"));
  new RunPins(db, s1).start("r1");
  const s2 = await new DefinitionStore({ load: async () => [skill("one"), skill("two")] }).init();
  const p2 = new RunPins(db, s2);
  assert.deepEqual(p2.repinAll(), ["r1"]);
  assert.equal(p2.versionOf("r1"), s2.snapshotVersion);
});

test("AC-6 migration is additive and preserves existing data", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date() };
  const rt = new SqliteStore(db, clock);
  await rt.create({ apiVersion: "v1", kind: "WorkItem", metadata: { name: "w" }, spec: {} } as Resource);
  const s = await new DefinitionStore({ load: async () => [] }).init();
  new RunPins(db, s);
  new RunPins(db, s); // idempotent
  const again = new SqliteStore(db, clock);
  assert.ok(await again.get("WorkItem", "default", "w"));
});
