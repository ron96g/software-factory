import test from "node:test";
import assert from "node:assert/strict";
import { resolveRef } from "./refs.ts";
import type { ResourceReader } from "../ports/index.ts";

const objects: Record<string, { name: string; ns: string }> = {
  "team-a/a": { name: "a", ns: "team-a" },
  "team-b/b": { name: "b", ns: "team-b" },
  "factory-system/s": { name: "s", ns: "factory-system" },
};
const reader = {
  get: async (_kind: string, ns: string, name: string) => objects[`${ns}/${name}`] ?? null,
} as unknown as ResourceReader;

test("ADR-0011 (unchanged by ADR-0077): only same-namespace and factory-system refs resolve", async () => {
  assert.ok(await resolveRef(reader, "Agent", { name: "a" }, "team-a"));
  assert.ok(await resolveRef(reader, "Agent", { name: "s" }, "team-a"));
  assert.ok(await resolveRef(reader, "Agent", { name: "s", namespace: "factory-system" }, "team-a"));
  assert.equal(await resolveRef(reader, "Agent", { name: "b", namespace: "team-b" }, "team-a"), null);
  assert.equal(await resolveRef(reader, "Agent", { name: "b" }, "team-a"), null);
});
