import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GET } from "./route.ts";

test("readyz: AC-1 returns 200 {status:ready}; AC-2 has no factory/principal dependency", async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ready" });
  const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("getFactory") && !src.includes("principalFrom"));
});
