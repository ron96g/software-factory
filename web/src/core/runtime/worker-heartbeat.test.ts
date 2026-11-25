import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { WorkspaceLock } from "../ports/index.ts";
import { SqliteWorkspaceLock } from "../store/workspace-lock.ts";
import { WORKER_LEASE_PREFIX, WorkerHeartbeat } from "./worker-heartbeat.ts";

const lockWith = (now: () => Date) => new SqliteWorkspaceLock(new DatabaseSync(":memory:"), { now });

/** A lock that fails, to prove the heartbeat never takes the process down with it. */
const failing = (overrides: Record<string, unknown> = {}) =>
  ({
    acquire: async () => undefined,
    renew: async () => false,
    release: async () => {},
    get: async () => undefined,
    list: async () => [],
    releaseHolder: async () => 0,
    ...overrides,
  }) as unknown as WorkspaceLock;

/** ADR-0062 §3: a worker's liveness must be observable without a check running. */
test("a worker announces itself with a live lease and withdraws it on a clean stop", async () => {
  const lock = lockWith(() => new Date("2026-11-24T10:00:00Z"));
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:42", ttlMs: 30_000 });
  assert.equal(heartbeat.key, "worker/worker:42");

  await heartbeat.start();
  assert.ok(await lock.get("worker/worker:42"), "the process is announced");
  assert.deepEqual((await lock.list(WORKER_LEASE_PREFIX)).map((l) => l.holder), ["worker:42"]);

  await heartbeat.stop();
  assert.equal(await lock.get("worker/worker:42"), undefined, "a clean stop withdraws the announcement");
  assert.equal((await lock.list(WORKER_LEASE_PREFIX)).length, 0);
});

/** A crash is not a clean stop: the announcement must expire from the store's clock, not linger forever. */
test("an announcement that is not renewed expires with its TTL", async () => {
  let now = new Date("2026-11-24T10:00:00Z");
  const lock = lockWith(() => now);
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:43", ttlMs: 30_000 });
  await heartbeat.start();

  now = new Date("2026-11-24T10:00:31Z"); // the process died; nothing renewed it
  assert.equal(await lock.get("worker/worker:43"), undefined, "the dead worker stops looking alive");
  assert.equal((await lock.list(WORKER_LEASE_PREFIX)).length, 0);
  await heartbeat.stop();
});

/** The lease TTL is short compared with a check, so the heartbeat must renew it (ADR-0062 §2: from the store clock). */
test("the heartbeat renews the announcement past its TTL", async () => {
  const lock = lockWith(() => new Date());
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:44", ttlMs: 1500 });
  await heartbeat.start();
  try {
    await new Promise((r) => setTimeout(r, 1200)); // longer than the TTL, past one renewal interval
    assert.ok(await lock.get("worker/worker:44"), "the lease is still live without a new start()");
  } finally {
    await heartbeat.stop();
  }
});

/** `start()` twice must not open a second timer or lose the lease. */
test("start is idempotent", async () => {
  const lock = lockWith(() => new Date("2026-11-24T10:00:00Z"));
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:45", ttlMs: 30_000 });
  await heartbeat.start();
  await heartbeat.start();
  assert.equal((await lock.list(WORKER_LEASE_PREFIX)).length, 1);
  await heartbeat.stop();
  assert.equal((await lock.list(WORKER_LEASE_PREFIX)).length, 0);
});

/** A store that is briefly unavailable must be reported, never thrown: the worker has checks to run. */
test("a failing beat is reported instead of rejecting start", async () => {
  const errors: string[] = [];
  const lock = failing({ acquire: async () => { throw new Error("database is locked"); } });
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:46", onError: (m) => errors.push(m) });

  await heartbeat.start();
  await heartbeat.stop();
  assert.match(errors[0] ?? "", /database is locked/);
});

/** A lease that cannot be withdrawn expires with its TTL; shutdown must still continue. */
test("stop reports a lease that could not be withdrawn instead of failing the shutdown", async () => {
  const errors: string[] = [];
  const lock = failing({
    acquire: async () => ({ holder: "worker:47", generation: 1, expiresAt: new Date(Date.now() + 30_000).toISOString() }),
    release: async () => { throw new Error("database is closed"); },
  });
  const heartbeat = new WorkerHeartbeat({ lock, holder: "worker:47", onError: (m) => errors.push(m) });

  await heartbeat.start();
  await heartbeat.stop();
  assert.match(errors.join("|"), /could not be withdrawn/);
});
