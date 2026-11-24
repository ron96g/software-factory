import assert from "node:assert/strict";
import { test } from "node:test";
import { flakyEvidence, untouchedFailures } from "./flaky.ts";
import { testId } from "./tests.ts";
import type { CheckRun } from "./kinds.ts";

type Failed = { name: string; file?: string; touched?: boolean };
const run = (name: string, failed: Failed[], passed: string[], o: { rerunOf?: string; snapshot?: string; command?: string; outcome?: "Passed" | "AssertionFailed" | "UnknownFailure"; logsIncomplete?: boolean } = {}) => ({
  kind: "CheckRun", metadata: { name },
  spec: { snapshot: o.snapshot ?? "s1", command: o.command ?? "npm test", check: "unit-tests",
    workflow: o.rerunOf ? { purpose: "rerun-failed", rerunOf: o.rerunOf } : { purpose: "unit-readiness" } },
  status: { phase: "Completed", outcome: o.outcome ?? (failed.length ? "AssertionFailed" : "Passed"), finalSnapshot: o.snapshot ?? "s1", logsIncomplete: o.logsIncomplete,
    tests: { failed, passed: passed.map(testId), skipped: 0 } },
}) as unknown as CheckRun;
const f = (name: string, touched = false): Failed => ({ name, file: "web/src/a.test.ts", touched });

test("ADR-0086: different tests failing in two attempts, each passing in the other, is flaky", () => {
  const a = run("a1", [f("cleanup")], ["drafting", "x"]);
  const b = run("a2", [f("drafting")], ["cleanup", "x"]);
  assert.deepEqual(flakyEvidence([a, b]), { tests: ["cleanup", "drafting"], runs: ["a1", "a2"] });
});

test("ADR-0086: a test that fails in every attempt, or a failure the change touched, is never flaky", () => {
  assert.equal(flakyEvidence([run("a1", [f("x")], ["y"]), run("a2", [f("x")], ["y"])]), undefined);
  assert.equal(flakyEvidence([run("a1", [f("x", true)], ["y"]), run("a2", [f("y")], ["x"])]), undefined);
  assert.equal(flakyEvidence([run("a1", [{ name: "x" }], ["y"]), run("a2", [f("y")], ["x"])]), undefined, "unknown file");
  assert.equal(flakyEvidence([run("a1", [f("x")], ["y"])]), undefined, "one attempt alone");
});

test("ADR-0086: attempts must be comparable and complete", () => {
  const a = run("a1", [f("x")], ["y"]);
  assert.equal(flakyEvidence([a, run("a2", [f("y")], ["x"], { snapshot: "s2" })]), undefined);
  assert.equal(flakyEvidence([a, run("a2", [f("y")], ["x"], { command: "other" })]), undefined);
  assert.equal(flakyEvidence([a, run("a2", [f("y")], ["x"], { logsIncomplete: true })]), undefined);
  assert.equal(flakyEvidence([a, run("a2", [], [], { outcome: "UnknownFailure" })]), undefined);
});

test("ADR-0086: a targeted re-run of the failed attempt can show the failure was flaky", () => {
  const a = run("a1", [f("x")], ["y"]);
  assert.deepEqual(flakyEvidence([a, run("r1", [], ["x"], { rerunOf: "a1" })]), { tests: ["x"], runs: ["a1", "r1"] });
  assert.equal(flakyEvidence([a, run("r1", [f("x")], [], { rerunOf: "a1" })]), undefined, "fails again");
  assert.equal(flakyEvidence([a, run("r1", [], ["x"], { rerunOf: "other" })]), undefined, "re-run of another attempt");
  assert.equal(flakyEvidence([run("r1", [], ["x"], { rerunOf: "a1" })]), undefined, "a re-run alone is no attempt");
  assert.equal(untouchedFailures(a), true);
  assert.equal(untouchedFailures(run("a3", [f("x", true)], [])), false);
});
