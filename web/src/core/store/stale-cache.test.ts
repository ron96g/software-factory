import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionStore } from "./composite-store.ts";
import { DefaultModelResolver } from "../agents/model-resolver.ts";
import type { Resource } from "../model/resource.ts";

const provider = (model: string): Resource =>
  ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "ModelProvider", metadata: { name: "p", namespace: "a" },
    spec: { type: "t", default: true, models: { default: model } } }) as unknown as Resource;

test("AC-1 model resolver sees store changes without restart (no stale cache)", async () => {
  const store = await new DefinitionStore({ load: async () => [] }, () => undefined).init();
  const factories = { get: () => ({ create: () => ({}) }) } as any;
  const r = new DefaultModelResolver(store, { resolve: () => undefined } as any, factories);
  assert.equal(await r.resolve({ namespace: "a" }), undefined);
  await store.apply(provider("m1"));
  assert.equal((await r.resolve({ namespace: "a" }))?.model, "m1");
  await store.apply(provider("m2"));
  assert.equal((await r.resolve({ namespace: "a" }))?.model, "m2");
  await store.remove("ModelProvider", "a", "p");
  assert.equal(await r.resolve({ namespace: "a" }), undefined);
});
