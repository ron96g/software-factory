import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteWorkspaceLock } from "./workspace-lock.ts";

const make = () => {
  let now = Date.parse("2026-11-11T00:00:00Z");
  const db = new DatabaseSync(":memory:");
  return { lock: new SqliteWorkspaceLock(db, { now: () => new Date(now) }), advance: (ms: number) => (now += ms) };
};

test("X42b (ADR-0062 §2): the lock is exclusive and generation-fenced", async () => {
  const { lock } = make();
  const a = await lock.acquire("default/item", "web:1", 60_000);
  assert.ok(a);
  assert.equal(await lock.acquire("default/item", "web:2", 60_000), undefined, "another holder cannot take a live lock");
  assert.equal(await lock.renew("default/item", "web:1", a.generation, 60_000), true);
  assert.equal(await lock.renew("default/item", "web:1", a.generation + 1, 60_000), false, "a stale generation cannot renew");
  await lock.release("default/item", "web:1", a.generation);
  assert.equal(await lock.get("default/item"), undefined);
  assert.ok(await lock.acquire("default/item", "web:2", 60_000), "the lock is free after release");
});

test("X42b: an expired lease is reclaimable and cannot be renewed", async () => {
  const { lock, advance } = make();
  const a = (await lock.acquire("default/item", "web:1", 1000))!;
  assert.ok(a);
  advance(2000);
  assert.equal(await lock.renew("default/item", "web:1", a.generation, 1000), false, "an expired lease cannot be renewed");
  const b = (await lock.acquire("default/item", "web:2", 1000))!;
  assert.ok(b, "another holder reclaims the expired lease");
  assert.ok(b.generation > a.generation, "the generation advances");
  await lock.release("default/item", "web:1", a.generation);
  assert.ok(await lock.get("default/item"), "a stale holder's release is ignored");
});

test("X42b/X42c: list returns only live leases, filtered by prefix (concurrency limits)", async () => {
  const { lock, advance } = make();
  await lock.acquire("checkrun/default/uid1/a", "w1", 1000);
  await lock.acquire("checkrun/default/uid2/b", "w1", 60_000);
  await lock.acquire("item/default/uid1", "w1", 60_000);
  assert.equal((await lock.list()).length, 3);
  assert.deepEqual((await lock.list("checkrun/")).map((l) => l.key).sort(), ["checkrun/default/uid1/a", "checkrun/default/uid2/b"]);
  advance(2000); // the first check lease expires
  assert.deepEqual((await lock.list("checkrun/")).map((l) => l.key), ["checkrun/default/uid2/b"]);
});

test("X42b: two connections cannot both hold the lock (cross-process)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-lock-"));
  const file = join(dir, "factory.db");
  const db1 = new DatabaseSync(file);
  const db2 = new DatabaseSync(file);
  db1.exec("PRAGMA journal_mode = WAL");
  db2.exec("PRAGMA journal_mode = WAL");
  try {
    const clock = { now: () => new Date() };
    const a = new SqliteWorkspaceLock(db1, clock);
    const b = new SqliteWorkspaceLock(db2, clock);
    assert.ok(await a.acquire("default/item", "web:1", 60_000));
    assert.equal(await b.acquire("default/item", "web:2", 60_000), undefined);
    assert.equal((await b.get("default/item"))?.holder, "web:1");
  } finally {
    db1.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
