import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteChangeFeed } from "./change-feed.ts";
import { FeedWatcher } from "./feed-watcher.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { Resource } from "../model/resource.ts";

const clock = { now: () => new Date("2026-11-11T00:00:00Z") };
const obj = (kind: string, name: string): Resource => ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind, metadata: { name, namespace: "default" }, spec: {} });

test("X42c (ADR-0062 §1): the feed watcher delivers writes made by the store, filtered by kind", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteStore(db, clock);
  const watcher = new FeedWatcher({ feed: new SqliteChangeFeed(db), reader: store, pollMs: 100_000 });
  try {
    const seen: string[] = [];
    watcher.watch((e) => seen.push(`${e.type}:${e.object.metadata.name}`), ["WorkItem"]);
    await watcher.start();

    const a = await store.create<Resource>(obj("WorkItem", "a"));
    await watcher.poll();
    await store.update<Resource>({ ...a, spec: { x: 1 } });
    await watcher.poll();
    await store.delete("WorkItem", "default", "a");
    await store.create(obj("AgentRun", "r")); // not watched
    await watcher.poll();
    assert.deepEqual(seen, ["ADDED:a", "MODIFIED:a", "DELETED:a"]);
  } finally {
    watcher.stop();
  }
});

test("X42c: a cursor behind the retention window resyncs by re-listing the watched kinds", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteStore(db, clock, [], 1);
  const watcher = new FeedWatcher({ feed: new SqliteChangeFeed(db), reader: store, pollMs: 100_000 });
  try {
    const seen: string[] = [];
    watcher.watch((e) => seen.push(`${e.type}:${e.object.metadata.name}`), ["WorkItem"]);
    // No start(): the cursor stays at 0, and the retention window has moved past it.
    for (let i = 0; i < 4; i++) await store.create(obj("WorkItem", `w${i}`));
    await watcher.poll();
    assert.ok(seen.includes("ADDED:w3"), `expected a resync of the current objects, got: ${seen.join(", ")}`);
  } finally {
    watcher.stop();
  }
});
