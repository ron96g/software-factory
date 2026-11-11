import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteStore } from "../store/sqlite-store.ts";
import { StoreEventRecorder } from "./event-recorder.ts";
import { ControllerManager } from "./controller-manager.ts";
import { EventingReconcileErrorReporter } from "./reconcile-errors.ts";
import { SecretRedactor } from "../transcripts/recorder.ts";
import type { FactoryEvent } from "../model/kinds.ts";

test("Q2: repeated reconcile failures become a Warning event on the object; recovery is reported; secrets redacted", async () => {
  const clock = { now: () => new Date() };
  const store = new SqliteStore(new DatabaseSync(":memory:"), clock);
  const redactor = new SecretRedactor();
  redactor.add("sk-very-secret");
  const reporter = new EventingReconcileErrorReporter({ reader: store, events: new StoreEventRecorder(store), redactor, clock, threshold: 3, every: 10 });
  const manager = new ControllerManager(store, () => {}, reporter);
  let calls = 0;
  manager.register({
    name: "flaky",
    primaryKind: "WorkItem",
    watches: ["WorkItem"],
    keysFor: (e) => [`${e.object.metadata.namespace}/${e.object.metadata.name}`],
    async reconcile() {
      calls++;
      if (calls <= 3) throw new Error("boom with sk-very-secret");
    },
  });
  await manager.start();
  await store.create({ apiVersion: "x", kind: "WorkItem", metadata: { name: "wi" }, spec: {} });
  for (let i = 0; i < 300 && calls < 4; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  await manager.stop();

  const events = await store.list<FactoryEvent>("Event");
  const warning = events.find((e) => e.spec.reason === "ReconcileFailing");
  assert.ok(warning, "warning event recorded");
  assert.equal(warning.spec.involvedObject.name, "wi");
  assert.match(warning.spec.message, /flaky: attempt 3 failed: boom with «redacted»/);
  assert.ok(events.some((e) => e.spec.reason === "ReconcileRecovered"));
  assert.equal(reporter.failing().length, 0, "nothing failing after recovery");
  assert.equal(events.filter((e) => e.spec.reason === "ReconcileFailing").length, 1, "no event spam for attempts 1-2");
});
