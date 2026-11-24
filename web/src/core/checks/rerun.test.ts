import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { canRerunFailed, rerunCheckConfig } from "./config.ts";
import { nodeTestTapClassifier } from "./classifiers.ts";
import type { CheckRun, Repository } from "../model/kinds.ts";

const repository = (rerunFailed?: string) => ({ metadata: { name: "repo" },
  spec: { checks: { tests: { command: "node --test --test-reporter=tap", resultFormat: "node-test-tap", ...(rerunFailed ? { rerunFailed } : {}) } } } }) as unknown as Repository;
const original = (failed: { name: string; file?: string }[]) => ({ metadata: { name: "attempt-1" }, spec: { check: "tests" },
  status: { phase: "Completed", outcome: "AssertionFailed", tests: { failed, passed: [], skipped: 0 } } }) as unknown as CheckRun;
const env = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };

test("ADR-0086: a targeted re-run runs only the failed tests (with their enclosing tests); names never become shell syntax", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-rerun-"));
  const marker = join(dir, "pwned");
  try {
    mkdirSync(join(dir, "src"));
    const evil = `x'; touch ${marker}; echo '`;
    const subst = `$(touch ${marker})`;
    writeFileSync(join(dir, "src", "a.test.ts"), `import { test, describe } from "node:test";
      import assert from "node:assert/strict";
      test("passes", () => {});
      test(${JSON.stringify(evil)}, () => assert.fail("first"));
      describe("suite", () => { test(${JSON.stringify(subst)}, () => assert.fail("second")); test("sibling", () => {}); });
      test("parent", async (t) => { await t.test("AC-2 (sub)", () => assert.fail("third")); });`);
    const full = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "src/a.test.ts"], { cwd: dir, encoding: "utf8", env: env() });
    const result = { exitCode: full.status ?? 1, stdout: full.stdout, stderr: full.stderr, truncated: false, durationMs: 1 };
    const tests = nodeTestTapClassifier.testResults(result)!;
    assert.equal(tests.failed.length, 3);
    const failed = tests.failed.map((t) => ({ name: t.name, file: relative(dir, t.file!) }));

    const repo = repository(`node --test --test-reporter=tap --test-name-pattern="$FACTORY_RERUN_PATTERN" $FACTORY_RERUN_FILES`);
    const config = rerunCheckConfig(repo, "tests", original(failed));
    assert.equal(config.resultFormat, "node-test-tap");
    const rerun = spawnSync("sh", ["-c", `set -e\n${config.command}`], { cwd: dir, encoding: "utf8", env: env() });
    const again = nodeTestTapClassifier.testResults({ exitCode: rerun.status ?? 1, stdout: rerun.stdout, stderr: rerun.stderr, truncated: false, durationMs: 1 })!;
    assert.deepEqual(again.failed.map((t) => t.name).sort(), failed.map((t) => t.name).sort(), "exactly the failed tests run again");
    assert.ok(!again.passed.includes("passes"), "unrelated tests are not run");
    assert.equal(existsSync(marker), false, "no test name was executed as shell");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ADR-0086: no re-run without the repository's rerunFailed, named failures and safe files", () => {
  const ok = [{ name: "a", file: "src/a.test.ts" }];
  assert.equal(canRerunFailed(repository(), "tests", original(ok)), false, "not configured");
  const repo = repository("node --test $FACTORY_RERUN_FILES");
  assert.equal(canRerunFailed(repo, "tests", original(ok)), true);
  assert.equal(canRerunFailed(repo, "tests", original([{ name: "a" }])), false, "file unknown");
  assert.equal(canRerunFailed(repo, "tests", original([{ name: "a", file: "../etc/x.test.ts" }])), false);
  assert.equal(canRerunFailed(repo, "tests", original([{ name: "a", file: "src/a b.test.ts" }])), false);
  assert.equal(canRerunFailed(repo, "tests", original([{ name: "a\nb", file: "src/a.test.ts" }])), false);
  assert.equal(canRerunFailed(repo, "tests", { ...original(ok), status: { ...original(ok).status!, outcome: "UnknownFailure" } } as CheckRun), false);
});
