import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GET, dynamic } from "../app/healthz/route.ts";

test("AC-1: GET /healthz returns 200 {status:ok}", async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("AC-2: /healthz is force-dynamic and does not use handler() or the factory", () => {
  assert.equal(dynamic, "force-dynamic");
  const src = readFileSync(new URL("../app/healthz/route.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("handler") && !src.includes("getFactory"));
});
