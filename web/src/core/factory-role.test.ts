import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createFactory } from "./factory.ts";
import { testDefinitions } from "./testing/definitions.ts";

const ROOT = resolve(import.meta.dirname, "../..");

const make = (role: "all" | "web" | "worker") =>
  createFactory({ role, definitionsRoot: ROOT, definitionLoader: testDefinitions(), databasePath: ":memory:", env: {}, log: () => {} });

test("X42c (ADR-0062 §3): the worker registers only the CheckRun controller; the web root omits it", async () => {
  const worker = await make("worker");
  const web = await make("web");
  try {
    assert.deepEqual(worker.manager.names(), ["checkrun"], "the worker runs checks and nothing else");
    assert.ok(!web.manager.names().includes("checkrun"), "the web root never executes checks");
    assert.ok(web.manager.names().includes("workitem"), "the web root runs the workflow controllers");
  } finally {
    await worker.stop();
    await web.stop();
  }
});

test("X42c: the default role runs everything in one process", async () => {
  const all = await make("all");
  try {
    const names = all.manager.names();
    assert.ok(names.includes("checkrun") && names.includes("workitem"), "the single-process default keeps both");
  } finally {
    await all.stop();
  }
});
