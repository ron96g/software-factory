import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun, CheckRunStatus } from "../model/kinds.ts";
import { diagnoseCheckRun, explainAttempts, explainCheckRun } from "./explain.ts";

const run = (name: string, status: Partial<CheckRunStatus>): CheckRun => ({
  apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "CheckRun", metadata: { name, namespace: "default" },
  spec: { check: "build", command: "make build", timeoutMs: 1_800_000, snapshot: "a",
    scope: { mode: "affected", baseCommit: "b", graphHash: "g", modules: ["notification", "approval"], reason: "Changed modules and their transitive dependents." } },
  status: { phase: "Completed", ...status },
} as unknown as CheckRun);

const drift = (name: string) => run(name, { outcome: "NotVerified", executionOutcome: "Passed", durationMs: 70_000,
  message: "build: Passed (exit 0 in 70000 ms); check modified the workspace (restored)",
  workspaceChanges: { total: 1, files: [{ path: "svc/server.gen.go", change: "modified", added: 239, deleted: 219 }] } });

test("a check that rewrote the candidate names the files, the likely cause and the fix", () => {
  const text = explainCheckRun(drift("c1"));
  assert.match(text, /finished as Passed, but it wrote to the candidate \(1 file: modified svc\/server\.gen\.go \(\+239\/−219\)\)/);
  assert.match(text, /\*\*What to do:\*\*.*generated code that is out of date/);
  assert.match(text, /\*\*Scope:\*\* affected — 2 modules: notification, approval/);
  assert.match(text, /`make build`/);
});

test("repeated identical attempts are reported as deterministic; differing ones are not", () => {
  assert.match(explainAttempts([drift("c1"), drift("c2")]), /Every attempt ended the same way/);
  const differing = explainAttempts([run("c1", { outcome: "TimedOut", durationMs: 1_800_000 }), drift("c2")]);
  assert.doesNotMatch(differing, /Every attempt ended the same way/);
  assert.match(differing, /1\. `c1`: TimedOut after 1800 s\n2\. `c2`: NotVerified after 70 s, modified the workspace/);
});

test("each outcome gets a cause and an action, not just its name", () => {
  for (const [status, what, hint] of [
    [{ outcome: "TimedOut" }, /within its 30 min budget/, /timeoutMs.*2 modules/],
    [{ outcome: "SetupFailed", exitCode: 2 }, /prerequisite/, /SandboxProfile/],
    [{ outcome: "Unavailable" }, /could not be started/, /tool gaps/],
    [{ outcome: "UnknownFailure", exitCode: 1 }, /exit 1/, /output/],
    [{ outcome: "NotVerified", executionOutcome: "Passed", logsIncomplete: true }, /incomplete/, /maxOutputBytes/],
    [{ phase: "Interrupted" }, /interrupted/, /worker/],
  ] as const) {
    const d = diagnoseCheckRun(run("c", status as Partial<CheckRunStatus>));
    assert.match(d.what, what);
    assert.match(d.hint ?? "", hint);
  }
});
