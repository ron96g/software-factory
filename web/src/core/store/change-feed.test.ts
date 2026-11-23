import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteChangeFeed } from "./change-feed.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { Resource } from "../model/resource.ts";

const clock = { now: () => new Date("2026-11-11T00:00:00Z") };
const obj = (kind: string, name: string, spec: unknown = {}): Resource => ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind, metadata: { name, namespace: "default" }, spec });
const pair = (retention: number) => {
  const db = new DatabaseSync(":memory:");
  return { store: new SqliteStore(db, clock, [], retention), feed: new SqliteChangeFeed(db) };
};

test("X42a (ADR-0062 §1): the change feed records every write in order, with the resource's version", async () => {
  const { store, feed } = pair(10_000);
  const a = await store.create(obj("WorkItem", "a"));
  await store.update({ ...a, spec: { x: 1 } });
  await store.delete("WorkItem", "default", "a");

  const { entries, cursor, resync } = await feed.since(0);
  assert.equal(resync, false);
  assert.deepEqual(entries.map((e) => e.type), ["ADDED", "MODIFIED", "DELETED"]);
  assert.deepEqual(entries.map((e) => e.name), ["a", "a", "a"]);
  assert.equal(entries[0].kind, "WorkItem");
  assert.equal(entries[0].resourceVersion, a.metadata.resourceVersion);
  assert.ok(entries[0].seq < entries[1].seq && entries[1].seq < entries[2].seq, "sequences increase");
  assert.equal(cursor, entries[2].seq);
  assert.equal((await feed.since(cursor)).entries.length, 0, "the cursor is consumed");
});

test("X42a: the feed filters by kind and reports its head", async () => {
  const { store, feed } = pair(10_000);
  await store.create(obj("WorkItem", "a"));
  await store.create(obj("AgentRun", "r"));
  assert.equal(await feed.head(), 2);
  const { entries } = await feed.since(0, ["AgentRun"]);
  assert.deepEqual(entries.map((e) => e.kind), ["AgentRun"]);
});

test("X42a: a cursor older than the retained window resyncs instead of missing changes", async () => {
  const { store, feed } = pair(2);
  for (let i = 0; i < 5; i++) await store.create(obj("WorkItem", `w${i}`));
  assert.equal((await feed.since(0)).resync, true, "the consumer missed pruned changes");
  const fresh = await feed.head();
  assert.equal((await feed.since(fresh)).resync, false);
});

test("X42a: a second connection sees changes written by the first (cross-process)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-feed-"));
  const file = join(dir, "factory.db");
  const db1 = new DatabaseSync(file);
  const db2 = new DatabaseSync(file);
  db1.exec("PRAGMA journal_mode = WAL");
  db2.exec("PRAGMA journal_mode = WAL");
  try {
    const store = new SqliteStore(db1, clock);
    const feed = new SqliteChangeFeed(db2);
    const before = await feed.head();
    await store.create(obj("WorkItem", "a"));
    const { entries } = await feed.since(before);
    assert.deepEqual(entries.map((e) => e.name), ["a"], "a separate connection sees the write");
  } finally {
    db1.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
