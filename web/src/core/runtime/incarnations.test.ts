import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { reapStaleIncarnations, incarnationId } from "./incarnations.ts";
import { SqliteWorkspaceLock } from "../store/workspace-lock.ts";

const clock = { now: () => new Date("2026-11-11T00:00:00Z") };

test("X42c (ADR-0062 §2): a previous incarnation's locks are released only after its processes are confirmed gone", async () => {
  const db = new DatabaseSync(":memory:");
  const lock = new SqliteWorkspaceLock(db, clock);
  await lock.acquire("item/default/uid1", "web:100", 60_000);
  await lock.acquire("item/default/uid2", "web:100", 60_000);
  await lock.acquire("item/default/uid3", "web:200", 60_000); // the current incarnation

  // A killer that cannot confirm death releases nothing (the stale holder might still be running).
  assert.deepEqual(await reapStaleIncarnations({ lock, killer: { kill: async () => false }, current: "web:200" }), []);
  assert.equal((await lock.list()).length, 3);

  // A killer that confirms the old incarnation is gone releases exactly its locks.
  assert.deepEqual(await reapStaleIncarnations({ lock, killer: { kill: async () => true }, current: "web:200" }), ["web:100"]);
  assert.deepEqual((await lock.list()).map((l) => l.holder), ["web:200"]);
});

test("X42c: FACTORY_INCARNATION overrides the generated holder identity", () => {
  assert.equal(incarnationId("web", { FACTORY_INCARNATION: "web:custom" }, 999), "web:custom");
  assert.equal(incarnationId("worker", {}, 42), "worker:42");
});
