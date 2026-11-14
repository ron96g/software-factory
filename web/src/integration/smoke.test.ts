import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionStore } from "../core/store/composite-store.ts";
import { RunPins } from "../core/store/run-pins.ts";
import type { Resource } from "../core/model/resource.ts";

const agent = (n: string, body: string): Resource => ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "Agent", metadata: { name: n, namespace: "a" }, spec: { body } } as Resource);

test("AC-6 integration: a run spanning a definition change stays on its snapshot", async () => {
  const store = await new DefinitionStore({ load: async () => [agent("dev", "v1")] } as never).init();
  const pins = new RunPins(new DatabaseSync(":memory:"), store);
  const v = pins.start("run1");
  await store.apply(agent("dev", "v2"));
  const old = store.snapshot(v)!;
  assert.equal((old[0] as any).spec.body, "v1");
  assert.equal((store.snapshot(store.snapshotVersion)![0] as any).spec.body, "v2");
  pins.end("run1");
  assert.equal(store.snapshot(v), undefined);
});

test("AC-3 integration: bulk apply admits mutually referencing set as a whole", async () => {
  const store = await new DefinitionStore({ load: async () => [] } as never, (c) => (c.length > 5 ? "bad" : undefined)).init();
  assert.equal((await store.bulkApply([agent("x", "1"), agent("y", "2")])).ok, true);
  assert.equal((await store.bulkApply(Array.from({ length: 9 }, (_, i) => agent("n" + i, "")))).ok, false);
  assert.equal(store.snapshotVersion, 1);
});
