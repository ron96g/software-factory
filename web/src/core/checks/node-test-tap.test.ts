import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { nodeTestTapClassifier } from "./classifiers.ts";
import type { ExecResult } from "../ports/sandbox.ts";

function node(source: string): ExecResult {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test-reporter=tap", "--input-type=module", "-e", source], { encoding: "utf8", env });
  return { exitCode: result.status ?? 127, stdout: result.stdout, stderr: result.stderr, truncated: false, durationMs: 1,
    termination: { kind: "exit" } };
}

test("ADR-0086: Node TAP names every failure raised by test code; hooks, crashes and setup stay unknown", () => {
  const assertion = node(`import {test} from "node:test"; import assert from "node:assert/strict"; test("fails", () => assert.equal(1,2));`);
  assert.equal(nodeTestTapClassifier.classify(assertion), "AssertionFailed");
  assert.deepEqual(nodeTestTapClassifier.failureEvidence!(assertion), { tests: ["fails"] });
  assert.equal(nodeTestTapClassifier.classify({ ...assertion, truncated: true }), "NotVerified");
  assert.equal(nodeTestTapClassifier.failureEvidence!({ ...assertion, truncated: true }), undefined);
  assert.equal(nodeTestTapClassifier.classify({ ...assertion, stdout: assertion.stdout.replace(/# fail \d+/, "") }), "NotVerified");
  const thrown = node(`import {test} from "node:test"; test("cleanup", () => { throw new Error("ENOTEMPTY: directory not empty"); });`);
  assert.equal(nodeTestTapClassifier.classify(thrown), "AssertionFailed");
  assert.deepEqual(nodeTestTapClassifier.failureEvidence!(thrown), { tests: ["cleanup"] });
  const hook = node(`import {test, before} from "node:test"; before(() => { throw new Error("db down"); }); test("t", () => {});`);
  assert.equal(nodeTestTapClassifier.classify(hook), "UnknownFailure");
  assert.equal(nodeTestTapClassifier.failureEvidence!(hook), undefined);
  const missing = node(`import "./module-that-does-not-exist.js";`);
  assert.notEqual(nodeTestTapClassifier.classify(missing), "AssertionFailed");
  const passing = node(`import {test} from "node:test"; test("passes", () => {});`);
  assert.equal(nodeTestTapClassifier.classify(passing), "Passed");
});

test("assertion evidence is normalized, sorted, bounded and never includes diagnostics", () => {
  const result = node(`import {test} from "node:test"; import assert from "node:assert/strict";
    test("z", () => assert.equal("secret diagnostic", "other"));
    test("a", () => assert.equal(1, 2));`);
  assert.deepEqual(nodeTestTapClassifier.failureEvidence!(result), { tests: ["a", "z"] });
  const oversized = { ...result, stdout: result.stdout.replace("not ok 1 - z", `not ok 1 - ${"x".repeat(257)}`) };
  assert.equal(nodeTestTapClassifier.failureEvidence!(oversized), undefined);
});

test("ADR-0086: per-test results use the full name path; parents and skipped tests are not results", () => {
  const result = node(`import {test, describe} from "node:test"; import assert from "node:assert/strict";
    test("ok", () => {});
    describe("suite", () => { test("inner fails", () => assert.ok(false)); test("inner ok", () => {}); });
    test("parent", async (t) => { await t.test("AC-1", () => {}); await t.test("AC-2", () => { throw new Error("x"); }); });
    test.skip("later", () => {});`);
  assert.equal(nodeTestTapClassifier.classify(result), "AssertionFailed");
  const tests = nodeTestTapClassifier.testResults(result)!;
  assert.deepEqual(tests.failed.map((t) => t.name), ["suite › inner fails", "parent › AC-2"]);
  assert.ok(tests.failed.every((t) => !!t.file && !/:\d+:\d+$/.test(t.file)));
  assert.deepEqual(tests.passed, ["ok", "suite › inner ok", "parent › AC-1"]);
  assert.equal(tests.skipped, 1);
  assert.equal(nodeTestTapClassifier.testResults({ ...result, truncated: true }), undefined);
  const passing = node(`import {test} from "node:test"; test("passes", () => {});`);
  assert.deepEqual(nodeTestTapClassifier.testResults(passing), { failed: [], passed: ["passes"], skipped: 0 });
});
