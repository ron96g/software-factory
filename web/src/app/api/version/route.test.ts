import test from "node:test";
import assert from "node:assert/strict";
import pkg from "../../../../package.json" with { type: "json" };
import { GET } from "./route.ts";

test("AC-1", async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, pkg.version);
});
