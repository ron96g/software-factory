import assert from "node:assert/strict";
import { test } from "node:test";
import { renderVerificationReport } from "./render.ts";

test("a verification-report renders as readable Markdown, not raw JSON", () => {
  const md = renderVerificationReport(JSON.stringify({
    verdict: "partial",
    summary: "Build and all configured test checks are green.",
    reasons: ["build, unit-tests and focused-tests all Passed"],
    traceMatrix: [{ criterion: "AC-1", requirement: "Returns 200 with an ETag", evidence: "controller_test.go:107", result: "pass", coveredBy: "controlplane/unit-tests" }],
    checks: { "controlplane/build": "Passed", "controlplane/security-scan": "missing (no configured command)" },
    missingEvidence: ["controlplane/security-scan has no configured command"],
    notes: ["Unrelated generated changes appear in the diff"],
  }));
  assert.ok(md, "renders a report");
  assert.match(md!, /^\*\*Verdict: partial\*\*/);
  assert.match(md!, /Build and all configured test checks are green\./);
  assert.match(md!, /### Why/);
  assert.match(md!, /### Acceptance criteria/);
  assert.match(md!, /\| AC-1 \| ✅ pass \| Returns 200 with an ETag \|/);
  assert.match(md!, /controller_test\.go:107/);
  assert.match(md!, /### Checks/);
  assert.match(md!, /\| controlplane\/build \| Passed \|/);
  assert.match(md!, /### Missing evidence/);
  assert.match(md!, /### Notes/);
  assert.doesNotMatch(md!, /^\{/, "not a JSON blob");
});

test("the renderer escapes table-hostile characters and never fabricates missing fields", () => {
  const md = renderVerificationReport(JSON.stringify({ verdict: "pass", traceMatrix: [{ criterion: "AC-2", requirement: "a | b\nsecond line" }] }))!;
  assert.match(md, /a \\\| b second line/);
});

test("unrecognised or invalid content renders nothing, so callers fall back to raw", () => {
  assert.equal(renderVerificationReport("{ not json"), null);
  assert.equal(renderVerificationReport(JSON.stringify({ unrelated: true })), null);
  assert.equal(renderVerificationReport(JSON.stringify([1, 2, 3])), null);
});
