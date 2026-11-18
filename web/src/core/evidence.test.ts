import test from "node:test";
import assert from "node:assert/strict";
import { countsAsPassed } from "./verification/evidence.ts";
import type { CheckRun } from "./model/kinds.ts";

const run = (format: string | undefined, incomplete: boolean, final = "s"): CheckRun => ({
  spec: { snapshot: "s", resultFormat: format }, status: { phase: "Completed", outcome: "Passed", finalSnapshot: final, logsIncomplete: incomplete },
}) as unknown as CheckRun;

test("AC-5: incomplete logs count for exit-code-only checks with unchanged snapshot", () => {
  assert.equal(countsAsPassed(run(undefined, true)), true);
  assert.equal(countsAsPassed(run("exit-code", true)), true);
  assert.equal(countsAsPassed(run("go-test-json", true)), false);
  assert.equal(countsAsPassed(run("go-test-json", false)), true);
  assert.equal(countsAsPassed(run("exit-code", true, "other")), false);
});
