import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteFencedStatusWriter } from "./fenced-status.ts";
import { SqliteStore } from "./sqlite-store.ts";
import { SqliteWorkspaceLock } from "./workspace-lock.ts";
import type { Resource } from "../model/resource.ts";

type Doc = Resource & { status?: { phase?: string } };
const checkRun = (): Doc => ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "CheckRun", metadata: { name: "c", namespace: "default" }, spec: {}, status: { phase: "Running" } });

test("X42c (ADR-0062 §1/§2): a stale holder cannot write the status of a CheckRun it no longer owns", async () => {
  let now = Date.parse("2026-11-11T00:00:00Z");
  const db = new DatabaseSync(":memory:");
  const store = new SqliteStore(db, { now: () => new Date(now) });
  const lock = new SqliteWorkspaceLock(db, { now: () => new Date(now) });
  const fenced = new SqliteFencedStatusWriter(store, lock);

  const run = await store.create<Doc>(checkRun());
  const lease = (await lock.acquire("checkrun/default/c", "worker:1", 1000))!;
  const ref = { key: "checkrun/default/c", holder: lease.holder, generation: lease.generation };

  const ok = await fenced.updateStatusIf<Doc>({ ...run, status: { phase: "Completed" } }, ref);
  assert.equal(ok?.status?.phase, "Completed", "the lease holder writes");

  // The lease expires; another worker claims the run (generation bumps). The first worker's late write must be rejected.
  now += 5000;
  const takeover = await lock.acquire("checkrun/default/c", "worker:2", 60_000);
  assert.equal(takeover?.generation, lease.generation + 1);
  const current = (await store.get<Doc>("CheckRun", "default", "c"))!;
  const stale = await fenced.updateStatusIf<Doc>({ ...current, status: { phase: "Interrupted" } }, ref);
  assert.equal(stale, null, "a stale generation cannot write status");
  assert.equal((await store.get<Doc>("CheckRun", "default", "c"))!.status?.phase, "Completed", "the accepted write stands");
});
