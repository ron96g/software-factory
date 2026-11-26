import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactMarkdown, ticketDraftMarkdown, verificationReportMarkdown } from "./artifact-content.ts";
import type { Artifact } from "../core/model/kinds.ts";

const artifact = (type: string, content: string, format?: "json") =>
  ({ kind: "Artifact", metadata: { name: `a-${type}` }, spec: { artifactTypeRef: { name: type }, content, ...(format ? { format } : {}) } }) as unknown as Artifact;

test("a verification-report renders as readable Markdown, not raw JSON", () => {
  const report = artifact("verification-report", JSON.stringify({
    verdict: "partial",
    summary: "Build and all configured test checks are green.",
    reasons: ["build, unit-tests and focused-tests all Passed"],
    traceMatrix: [{ criterion: "AC-1", requirement: "Returns 200 with an ETag", evidence: "controller_test.go:107", result: "pass", coveredBy: "controlplane/unit-tests" }],
    checks: { "controlplane/build": "Passed", "controlplane/security-scan": "missing (no configured command)" },
    missingEvidence: ["controlplane/security-scan has no configured command"],
    notes: ["Unrelated generated changes appear in the diff"],
  }), "json");
  const md = verificationReportMarkdown(report);
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
  assert.equal(artifactMarkdown(report), md);
});

test("the renderer escapes table-hostile characters and never fabricates missing fields", () => {
  const report = artifact("verification-report", JSON.stringify({ verdict: "pass", traceMatrix: [{ criterion: "AC-2", requirement: "a | b\nsecond line" }] }), "json");
  const md = verificationReportMarkdown(report)!;
  assert.match(md, /a \\\| b second line/);
});

test("non-report artifacts stay raw: unknown or invalid content renders nothing", () => {
  assert.equal(verificationReportMarkdown(artifact("spec", "# Spec")), null);
  assert.equal(artifactMarkdown(artifact("code-review-report", "**Verdict: approve**")), null);
  assert.equal(verificationReportMarkdown(artifact("verification-report", "{ not json")), null);
  assert.equal(verificationReportMarkdown(artifact("verification-report", JSON.stringify({ unrelated: true }))), null);
});

test("a ticket-draft still renders as the publishable ticket (unchanged)", () => {
  const draft = artifact("ticket-draft", JSON.stringify({ title: "T", body: "B" }));
  assert.match(ticketDraftMarkdown(draft)!, /^# T\n\nB/);
  assert.equal(artifactMarkdown(draft), ticketDraftMarkdown(draft));
});

test("a pr-review-report renders as the review to be posted, not raw JSON", () => {
  const md = artifactMarkdown(artifact("pr-review-report", JSON.stringify({
    verdict: "partially-accepted", summary: "Changes the exported constant without a test.", rationale: "The value is right but untested.",
    accepted: ["The new value"], requiredChanges: ["Add a test for answer"],
    findings: [{ severity: "blocking", path: "app.ts", line: 1, message: "No test covers the new value." }, { severity: "non-blocking", path: "README.md", message: "Mention the new value." }],
  }), "json"));
  assert.ok(md);
  assert.match(md, /^## Verdict: Partially accepted\n[\s\S]*### Accepted\n- The new value\n\n### Required changes\n- Add a test for answer/);
  assert.match(md, /### Blocking findings\n- `app\.ts:1` _\(inline comment\)_ No test covers/);
  assert.match(md, /### Non-blocking findings\n- `README\.md` _\(in the review\)_ Mention/);
  assert.doesNotMatch(md, /"verdict"/);
  assert.equal(artifactMarkdown(artifact("pr-review-report", "{not json", "json")), null);
});

test("a pr-review-report from the earlier format still renders, with a hint to restart", () => {
  const md = artifactMarkdown(artifact("pr-review-report", JSON.stringify({
    verdict: "request-changes", summary: "Changes the exported constant without a test.",
    findings: [{ severity: "blocking", path: "app.ts", line: 1, message: "No test covers the new value." }],
  }), "json"));
  assert.ok(md, "not raw JSON");
  assert.match(md, /^## Verdict: Request changes\n/);
  assert.match(md, /### Blocking findings\n- `app\.ts:1` No test covers/);
  assert.match(md, /earlier report format: restart from analyze/);
  assert.doesNotMatch(md, /\*\*Why:\*\*/);
});

test("the gate preview shows where each finding will appear and its suggestion", () => {
  const md = artifactMarkdown(artifact("pr-review-report", JSON.stringify({
    verdict: "partially-accepted", summary: "Changes the exported constant without a test.", rationale: "The value is right but untested.",
    accepted: ["The new value"], requiredChanges: ["Add a test for answer"],
    findings: [{ severity: "blocking", path: "app.ts", startLine: 1, line: 2, message: "No test covers it.", suggestion: "const x = 1;" },
      { severity: "non-blocking", path: "README.md", message: "Mention the new value." }],
  }), "json"))!;
  assert.match(md, /- `app\.ts:1-2` _\(inline comment\)_ No test covers it\.\n\n  ```suggestion\n  const x = 1;\n  ```/);
  assert.match(md, /- `README\.md` _\(in the review\)_ Mention/);
});
