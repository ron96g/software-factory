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

test("Node TAP classifies real assertion failures, not runtime or setup failures", () => {
  const assertion = node(`import {test} from "node:test"; import assert from "node:assert/strict"; test("fails", () => assert.equal(1,2));`);
  assert.equal(nodeTestTapClassifier.classify(assertion), "AssertionFailed");
  assert.deepEqual(nodeTestTapClassifier.failureEvidence!(assertion), { tests: ["fails"] });
  assert.equal(nodeTestTapClassifier.classify({ ...assertion, truncated: true }), "NotVerified");
  assert.equal(nodeTestTapClassifier.failureEvidence!({ ...assertion, truncated: true }), undefined);
  assert.equal(nodeTestTapClassifier.classify({ ...assertion, stdout: assertion.stdout.replace(/# fail \d+/, "") }), "NotVerified");
  const runtime = node(`import {test} from "node:test"; test("setup", () => { throw new Error("unavailable"); });`);
  assert.equal(nodeTestTapClassifier.classify(runtime), "UnknownFailure");
  assert.equal(nodeTestTapClassifier.failureEvidence!(runtime), undefined);
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
