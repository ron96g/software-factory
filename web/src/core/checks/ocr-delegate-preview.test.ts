import test from "node:test";
import assert from "node:assert/strict";
import { ocrDelegatePreviewClassifier as c, parseReviewScope, registerCheckResultClassifiers } from "./classifiers.ts";
import { BASE_COMMIT_TOKEN, checkConfig, resolveCheckConfig } from "./config.ts";
import type { Repository, Workspace } from "../model/kinds.ts";
import type { ExecResult } from "../ports/sandbox.ts";

const base = "a".repeat(40);
const res = (stdout: string, exitCode = 0, extra = {}) =>
  ({ stdout, stderr: "", exitCode, durationMs: 1, truncated: false, ...extra }) as ExecResult;
const preview = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: "1", mode: "range", repository: "/ws", from: base, to: "HEAD", merge_base: base,
  total_files: 3, reviewable_count: 2, excluded_count: 1,
  reviewable_files: [
    { path: "web/src/a.ts", status: "M", insertions: 4, deletions: 1 },
    { path: "web/src/b.ts", status: "A", insertions: 9, deletions: 0 },
  ],
  excluded_files: [{ path: "web/package-lock.json", status: "M", insertions: 40, deletions: 2, exclude_reason: "generated" }],
  ...over,
});

test("X63: a delegate preview is Passed evidence of the review scope, with counts parsed", () => {
  assert.equal(c.classify(res(preview())), "Passed");
  assert.deepEqual(parseReviewScope(res(preview())), { mode: "range", totalFiles: 3, reviewable: 2, excluded: 1 });
});

test("X63: every changed file is accounted for; an empty reviewable scope is not a pass", () => {
  assert.equal(c.classify(res(preview({
    total_files: 1, reviewable_count: 0, excluded_count: 1, reviewable_files: [],
    excluded_files: [{ path: "web/package-lock.json", status: "M", insertions: 2, deletions: 0, exclude_reason: "generated" }],
  }))), "NotVerified", "nothing was reviewable");
  assert.equal(c.classify(res(preview({ total_files: 0, reviewable_count: 0, excluded_count: 0, reviewable_files: [], excluded_files: [] }))),
    "NotVerified", "the pinned base compared nothing");
  assert.equal(c.classify(res(preview({ reviewable_count: 3 }))), "NotVerified", "counts must match the file lists");
  assert.equal(c.classify(res(preview({ total_files: -1 }))), "NotVerified");
});

test("X63: unparseable, truncated or unknown-contract output is never a pass", () => {
  assert.equal(c.classify(res("not json")), "NotVerified");
  assert.equal(c.classify(res("[]")), "NotVerified");
  assert.equal(c.classify(res(preview(), 0, { truncated: true })), "NotVerified");
  assert.equal(c.classify(res(preview({ schema_version: "2" }))), "NotVerified");
  assert.equal(c.classify(res(preview({ mode: "guess" }))), "NotVerified");
  assert.equal(c.classify(res(preview({ reviewable_files: "web/src/a.ts" }))), "NotVerified");
  assert.equal(parseReviewScope(res(preview(), 0, { truncated: true })), undefined);
});

test("X63: a missing CLI is a policy gap; other failures stay failures", () => {
  assert.equal(c.classify(res("", 127, { stderr: "sh: 1: ocr: not found" })), "Unavailable");
  assert.equal(c.classify(res("", 1, { stderr: "ocr: command not found" })), "Unavailable");
  assert.equal(c.classify(res("", 1, { stderr: "fatal: no such file or directory" })), "UnknownFailure", "a real git error is a failure");
  assert.equal(c.classify(res("", 1, { stderr: "no LLM provider configured" })), "UnknownFailure");
  assert.equal(c.classify(res(preview(), 1)), "UnknownFailure");
  assert.equal(c.classify(res("", 0, { termination: { kind: "timeout" } })), "TimedOut");
  assert.equal(c.classify(res("", 0, { termination: { kind: "signal" } })), "Cancelled");
  assert.equal(c.classify(res("", 0, { termination: { kind: "spawn-error" } })), "Unavailable");
});

test("X63: the ocr-delegate-preview format is registered", () => {
  const seen: string[] = [];
  registerCheckResultClassifiers({ register: (k: string) => { seen.push(k); } } as never);
  assert.ok(seen.includes("ocr-delegate-preview"));
});

const repository = (command: string) => ({
  metadata: { name: "repo", namespace: "default" },
  spec: { checks: { "review-scope": { command, resultFormat: "ocr-delegate-preview" } } },
}) as unknown as Repository;
const workspace = (baseCommit?: string) => ({
  metadata: { name: "item-repo", namespace: "default" },
  spec: { repositoryRef: { name: "repo" } },
  status: { phase: "Ready", baseCommit },
}) as unknown as Workspace;

test("X63: {{base}} comes from the pinned workspace, never from a guess", async () => {
  const repo = repository(`ocr delegate preview --format json --from ${BASE_COMMIT_TOKEN}`);
  const config = await resolveCheckConfig(repo, "review-scope", workspace(base));
  assert.equal(config.command, `ocr delegate preview --format json --from ${base}`);
  assert.equal(config.resultFormat, "ocr-delegate-preview");
  await assert.rejects(resolveCheckConfig(repo, "review-scope", workspace(undefined)), /pinned base commit/);
  await assert.rejects(resolveCheckConfig(repo, "review-scope", workspace("HEAD")), /pinned base commit/, "a ref name is not a pinned revision");
});

test("X63: unknown placeholders are rejected by policy, not passed to the shell", () => {
  assert.throws(() => checkConfig(repository("ocr review --from {{baseRef}}"), "review-scope"), /unknown command placeholders/);
  assert.throws(() => checkConfig(repository("ocr review --from {{ }}"), "review-scope"), /unknown command placeholders/);
  assert.match(checkConfig(repository("ocr delegate preview --from {{base}}"), "review-scope").command, /\{\{base\}\}$/);
});
