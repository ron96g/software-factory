import assert from "node:assert/strict";
import { test } from "node:test";
import { SEGMENT_MAX, buildChange, classifyGenerated, coverageOf, coverageProblems, ledgerOf, renderManifest, unreadSegments, type LedgerEntry } from "./change-manifest.ts";
import { ChangeReviewService } from "./change-review.ts";
import { prReviewReportReader } from "./pr-review.ts";
import { matchesGlob } from "node:path";
import type { ExecutionContext, NewTranscriptMessage, TranscriptMessage } from "../ports/index.ts";

const big = Array.from({ length: 900 }, (_, i) => `+line ${i} ${"x".repeat(20)}`).join("\n");
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@ function a()", " keep", "-old", "+new",
  "@@ -10,1 +10,2 @@", " ten", "+eleven",
  "diff --git a/src/big.ts b/src/big.ts", "new file mode 100644", "index 0..3", "--- /dev/null", "+++ b/src/big.ts",
  "@@ -0,0 +1,900 @@", big,
  "diff --git a/old/name.ts b/lib/name.ts", "similarity index 100%", "rename from old/name.ts", "rename to lib/name.ts",
  "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye",
  "diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-a", "+b",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ",
  "diff --git a/api/zz_generated.deepcopy.go b/api/zz_generated.deepcopy.go", "--- a/api/zz_generated.deepcopy.go", "+++ b/api/zz_generated.deepcopy.go", "@@ -1 +1 @@", "-a", "+b",
  "",
].join("\n");
const change = buildChange([{ name: "repo", head: "h".repeat(40), base: "b".repeat(40), patch: PATCH }]);
const file = (p: string) => change.manifest.files.find((f) => f.path === p)!;

test("the manifest lists every file with status, line counts, segments and review scope", () => {
  assert.deepEqual(change.manifest.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.inScope, f.scopeReason ?? ""]), [
    ["src/a.ts", "modified", 2, 1, true, ""],
    ["src/big.ts", "added", 900, 0, true, ""],
    ["lib/name.ts", "renamed", 0, 0, true, ""],
    ["gone.ts", "deleted", 0, 1, true, ""],
    ["package-lock.json", "modified", 1, 1, false, "lockfile"],
    ["img.png", "binary", 0, 0, false, "binary"],
    ["api/zz_generated.deepcopy.go", "modified", 1, 1, false, "generated"],
  ]);
  assert.equal(file("lib/name.ts").previousPath, "old/name.ts");
  assert.deepEqual(file("src/a.ts").segments.map((s) => [s.oldStart, s.oldLines, s.newStart, s.newLines]), [[1, 2, 1, 2], [10, 1, 10, 2]]);
  assert.equal(file("src/a.ts").module, "src");
});

test("a hunk larger than one tool result is split into segments that keep their line numbers", () => {
  const segs = file("src/big.ts").segments;
  assert.ok(segs.length > 1);
  assert.ok(segs.every((s) => s.bytes <= SEGMENT_MAX));
  assert.equal(segs[0].newStart, 1);
  assert.equal(segs[1].newStart, segs[0].newStart + segs[0].newLines);
  assert.equal(segs.reduce((n, s) => n + s.newLines, 0), 900);
});

test("the rendered manifest has metadata only, never patch text", () => {
  const text = renderManifest(change.manifest, true);
  assert.match(text, /#### src \(2 files, \+902 −1\)[\s\S]*\| src\/a\.ts \| modified \| \+2 −1 \| 2 \|/);
  assert.match(text, /\| package-lock\.json \| lockfile \|/);
  assert.match(text, /acknowledge_change/);
  assert.doesNotMatch(text, /\+new|-old/);
  assert.doesNotMatch(renderManifest(change.manifest, false), /acknowledge_change/);
});

const v = change.manifest.version;
const read = (path: string, segments: number[]): LedgerEntry => ({ type: "read", manifest: v, repository: "repo", path, segments });
const ack = (path: string, outcome: "reviewed" | "skipped", reason?: "budget-exhausted"): LedgerEntry => ({ type: "ack", manifest: v, repository: "repo", path, outcome, ...(reason ? { reason } : {}) });

test("a file counts as read only when every segment was read", () => {
  const ledger = ledgerOf([read("src/a.ts", [1])], v);
  assert.deepEqual(unreadSegments(ledger, file("src/a.ts")), [2]);
  assert.equal(unreadSegments(ledger, file("gone.ts")), "never-read");
  assert.deepEqual(unreadSegments(ledgerOf([read("src/a.ts", [1]), read("src/a.ts", [2])], v), file("src/a.ts")), []);
  assert.equal(unreadSegments(ledgerOf([read("src/a.ts", [1, 2])], "other-version"), file("src/a.ts")), "never-read", "reads are pinned to the manifest version");
});

test("finish rules: every in-scope file acknowledged, findings only on reviewed files, no accept with budget skips", () => {
  const partial = coverageOf(change.manifest, ledgerOf([ack("src/a.ts", "reviewed")], v));
  const problems = coverageProblems(change.manifest, partial, { verdict: "rejected", findingPaths: ["src/big.ts", "src/a.ts", "README.md"] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /3 in-scope file\(s\) are not acknowledged.*src\/big\.ts, lib\/name\.ts, gone\.ts/);
  assert.match(problems[1], /did not review: src\/big\.ts\./, "a finding on untouched code (README.md) is allowed");

  const skipped = coverageOf(change.manifest, ledgerOf(["src/a.ts", "lib/name.ts", "gone.ts"].map((p) => ack(p, "reviewed")).concat(ack("src/big.ts", "skipped", "budget-exhausted")), v));
  assert.match(coverageProblems(change.manifest, skipped, { verdict: "accepted", findingPaths: [] }).join(), /cannot accept code you have not read/);
  const claimed = coverageOf(change.manifest, ledgerOf(["src/a.ts", "src/big.ts", "gone.ts"].map((p) => ack(p, "reviewed")).concat(
    { type: "ack", manifest: v, repository: "repo", path: "lib/name.ts", outcome: "skipped", reason: "mechanical-rename" }), v));
  assert.deepEqual(coverageProblems(change.manifest, claimed, { verdict: "accepted", findingPaths: [] }), [], "a real rename may be skipped");
  const fake = coverageOf(change.manifest, ledgerOf(["src/big.ts", "lib/name.ts", "gone.ts"].map((p) => ack(p, "reviewed")).concat(
    { type: "ack", manifest: v, repository: "repo", path: "src/a.ts", outcome: "skipped", reason: "generated" }), v));
  assert.match(coverageProblems(change.manifest, fake, { verdict: "accepted", findingPaths: [] }).join(), /src\/a\.ts: generated/, "a claimed skip cannot be accepted unread");
  assert.deepEqual(coverageProblems(change.manifest, skipped, { verdict: "partially-accepted", findingPaths: [] }), []);
  assert.equal(skipped.outOfScope, 3);
});

function fakeCtx(heads: Record<string, string> = {}, generatedPaths: string[] = []) {
  const messages: TranscriptMessage[] = [];
  const ref = { namespace: "default", id: "t1" };
  const ws = { metadata: { name: "ws" }, spec: { repositoryRef: { name: "repo" }, checkout: { ref: "h" } }, status: { phase: "Ready", path: "/x", baseCommit: "b".repeat(40) } };
  const ctx = {
    workItem: { metadata: { name: "wi" }, spec: { pullRequest: { number: 1, headSha: "h".repeat(40), baseRef: "main" } } },
    run: { metadata: { name: "r" }, spec: { outputs: [{ name: "pr-review-report" }] } },
    workspaces: [ws],
    repositories: [{ metadata: { name: "repo" }, spec: { review: { generatedPaths } } }],
    transcript: { ref, record: async (m: NewTranscriptMessage) => { messages.push({ ...m, seq: messages.length + 1, at: "" }); } },
  } as unknown as ExecutionContext;
  const service = new ChangeReviewService({
    diffs: { diff: async () => ({ stat: "", patch: PATCH, truncated: false }) },
    transcripts: { read: async (_r, o) => messages.filter((m) => m.seq > (o?.afterSeq ?? 0)).slice(0, o?.limit ?? 10_000) },
    readers: { forWorkspaces: () => ({ readFile: async (p: string) => heads[p] ?? "package x", listFiles: async () => [] }) } as never,
    reports: { "pr-review-report": prReviewReportReader },
  });
  return { ctx, service, messages };
}

test("acknowledging a file as reviewed needs all its segments read; coverage comes from the recorded ledger", async () => {
  const { ctx, service } = fakeCtx();
  await service.provide(ctx);
  assert.deepEqual(await service.tools(ctx), ["read_change", "acknowledge_change"]);
  const s = service.session(ctx)!;
  assert.match(await s.acknowledge({ files: [{ path: "src/a.ts", outcome: "reviewed" }] }), /src\/a\.ts: REFUSED — not read yet/);
  const first = await s.read({ paths: ["src/big.ts"] });
  assert.match(first, /segments 1-\d+ of \d+/);
  assert.match(first, /\[\[truncated tool=read_change omitted=1_file\(s\) next=paths=\["src\/big\.ts"\]_from=\d+\]\]$/);
  assert.match(await s.acknowledge({ files: [{ path: "src/big.ts", outcome: "reviewed" }] }), /REFUSED — segment\(s\) [\d, ]+ not read/);
  await s.read({ paths: ["src/a.ts"] });
  assert.match(await s.acknowledge({ files: [{ path: "src/a.ts", outcome: "reviewed" }] }), /3 in-scope file\(s\) left/);
  assert.match(await s.acknowledge({ files: [{ path: "gone.ts", outcome: "skipped" }] }), /REFUSED — a skipped file needs reason/);
  await assert.rejects(s.read({ paths: ["nope.ts"] }), /not a changed file/);

  const report = (verdict: string) => ({ artifacts: [{ type: "pr-review-report", content: JSON.stringify({ verdict, summary: "s".repeat(20), rationale: "r".repeat(20), accepted: ["x x"], requiredChanges: ["fix it"], findings: [] }) }] });
  assert.match((await service.validate(ctx, report("rejected") as never)).join(), /3 in-scope file\(s\) are not acknowledged/);
  await s.read({ paths: ["lib/name.ts", "gone.ts"] });
  await s.acknowledge({ files: ["lib/name.ts", "gone.ts"].map((path) => ({ path, outcome: "reviewed" })) });
  await s.acknowledge({ files: [{ path: "src/big.ts", outcome: "skipped", reason: "budget-exhausted" }] });
  assert.deepEqual(await service.validate(ctx, report("rejected") as never), []);
  const coverage = await service.coverage({ spec: ctx.run.spec, status: { transcriptRef: ctx.transcript.ref } } as never);
  assert.deepEqual(coverage?.files.map((f) => [f.path, f.state, f.reason ?? ""]), [
    ["src/a.ts", "reviewed", ""], ["src/big.ts", "skipped", "budget-exhausted"], ["lib/name.ts", "reviewed", ""], ["gone.ts", "reviewed", ""]]);
});

test("a run that does not produce a review report may read the change but is not asked to acknowledge", async () => {
  const { ctx, service } = fakeCtx();
  (ctx.run.spec as { outputs: { name: string }[] }).outputs = [{ name: "pr-explanation" }];
  assert.deepEqual(await service.tools(ctx), ["read_change"]);
  assert.deepEqual(await service.validate(ctx, { artifacts: [{ type: "pr-explanation", content: "x" }] } as never), []);
});

test("gate evidence warns about in-scope files the reviewer skipped or never acknowledged", async () => {
  const { deriveGateEvidence } = await import("../app/gate-evidence.ts");
  const run = { metadata: { name: "wi-analyze-review-r1" }, spec: { stage: "analyze", step: "review-change", agentRef: { name: "reviewer" } }, status: { phase: "Succeeded" } };
  const coverage = coverageOf(change.manifest, ledgerOf([ack("src/a.ts", "reviewed"), ack("src/big.ts", "skipped", "budget-exhausted")], v));
  const evidence = deriveGateEvidence({ runs: [run as never], events: [], clarifications: [], coverage: new Map([[run.metadata.name, coverage]]) });
  assert.equal(evidence.status, "warning");
  assert.equal(evidence.items[0].label, "Review coverage · review-change: 1 of 4 in-scope files reviewed, 1 skipped, 2 not acknowledged; 3 out of scope (1 lockfile, 1 binary, 1 generated)");
  assert.match(evidence.items[0].detail, /src\/big\.ts \(budget-exhausted\), lib\/name\.ts \(unacknowledged\)/);
  assert.match(evidence.items[0].detail, /\nExcluded as generated: api\/zz_generated\.deepcopy\.go$/);
});

test("generated files: a header or a repository path puts them out of scope; a header added to a modified file does not", async () => {
  const patch = [
    "diff --git a/api/ent/listener_create.go b/api/ent/listener_create.go", "new file mode 100644", "--- /dev/null", "+++ b/api/ent/listener_create.go",
    "@@ -0,0 +1,2 @@", "+// Code generated by ent, DO NOT EDIT.", "+package ent",
    "diff --git a/api/ent.graphql b/api/ent.graphql", "--- a/api/ent.graphql", "+++ b/api/ent.graphql", "@@ -1 +1 @@", "-type A", "+type B",
    "diff --git a/api/sneaky.go b/api/sneaky.go", "--- a/api/sneaky.go", "+++ b/api/sneaky.go", "@@ -1,2 +1,3 @@", "+// Code generated by hand. DO NOT EDIT.", " package api", "-x", "+y",
    "diff --git a/api/regen.go b/api/regen.go", "--- a/api/regen.go", "+++ b/api/regen.go", "@@ -3,1 +3,1 @@", "-a", "+b",
    "diff --git a/api/old_gen.go b/api/old_gen.go", "deleted file mode 100644", "--- a/api/old_gen.go", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-// Code generated by mockgen. DO NOT EDIT.", "-package api",
    "diff --git a/api/mapper.go b/api/mapper.go", "--- a/api/mapper.go", "+++ b/api/mapper.go", "@@ -1 +1 @@", "-a", "+b", "",
  ].join("\n");
  const c = buildChange([{ name: "repo", head: "h".repeat(40), base: "b".repeat(40), patch }]);
  const heads: Record<string, string> = {
    "api/ent/listener_create.go": "// Code generated by ent, DO NOT EDIT.\npackage ent",
    "api/sneaky.go": "// Code generated by hand. DO NOT EDIT.\npackage api\ny",
    "api/regen.go": "// SPDX\n\n// Code generated by gqlgen, DO NOT EDIT.\npackage api",
    "api/mapper.go": "package api\n// mentions Code generated in prose only",
  };
  await classifyGenerated(c.files, () => ["api/*.graphql"], async (f) => heads[f.path], (p, g) => matchesGlob(p, g));
  assert.deepEqual(c.manifest.files.map((f) => [f.path, f.inScope, f.scopeReason ?? f.scopeNote ?? ""]), [
    ["api/ent/listener_create.go", false, "generated (header)"],
    ["api/ent.graphql", false, "generated (repository)"],
    ["api/sneaky.go", true, "its generated header was added by this change, so it is reviewed"],
    ["api/regen.go", false, "generated (header)"],
    ["api/old_gen.go", false, "generated (header)"],
    ["api/mapper.go", true, ""],
  ]);
});

test("read_change reads several files per call and says where to continue; acknowledge_change takes several files", async () => {
  const { ctx, service } = fakeCtx({ "api/zz_generated.deepcopy.go": "" });
  await service.provide(ctx);
  const s = service.session(ctx)!;
  const both = await s.read({ paths: ["src/a.ts", "gone.ts", "lib/name.ts"] });
  assert.match(both, /### repo:src\/a\.ts[\s\S]*### repo:gone\.ts[\s\S]*### repo:lib\/name\.ts/);
  assert.doesNotMatch(both, /truncated/);
  const many = await s.read({ paths: ["src/a.ts", "src/big.ts", "gone.ts"] });
  assert.match(many, /next=paths=\["src\/big\.ts"\]_from=\d+\]\]$/, "a file that does not fit is continued from its next segment");
  await assert.rejects(s.read({ paths: ["src/a.ts", "gone.ts"], from: 2 }), /single file/);
  const acked = await s.acknowledge({ files: [{ path: "src/a.ts", outcome: "reviewed" }, { path: "gone.ts", outcome: "reviewed" }, { path: "src/big.ts", outcome: "reviewed" }] });
  assert.match(acked, /- src\/a\.ts: reviewed\n- gone\.ts: reviewed\n- src\/big\.ts: REFUSED/);
});

test("the manifest is recorded once per run and the ledger is read incrementally", async () => {
  const { ctx, service, messages } = fakeCtx();
  await service.provide(ctx);
  await service.provide(ctx);
  assert.equal(messages.filter((m) => m.meta?.changeManifest).length, 1);
});

test("a read counts only after a later model step: a program or same-batch read cannot be acknowledged as seen", async () => {
  const { ctx, service } = fakeCtx();
  const step = (n: number) => ctx.transcript.record({ role: "note", author: { type: "system", id: "x" }, content: "model step ended", meta: { step: n } });
  await service.provide(ctx);
  await step(1);
  const s = service.session(ctx)!;
  await s.read({ paths: ["src/a.ts"] });
  assert.match(await s.acknowledge({ files: [{ path: "src/a.ts", outcome: "reviewed" }] }), /src\/a\.ts: REFUSED — not read yet \(a read counts once its result has reached you/);
  await step(2);
  assert.match(await s.acknowledge({ files: [{ path: "src/a.ts", outcome: "reviewed" }] }), /- src\/a\.ts: reviewed/);
});

test("budget-exhausted is accepted only in the last steps of the budget; results state the steps left", async () => {
  const { ctx, service } = fakeCtx();
  const step = (n: number) => ctx.transcript.record({ role: "note", author: { type: "system", id: "x" }, content: "step", meta: { step: n } });
  await service.provide(ctx);
  await step(20);
  const s = service.session(ctx, { maxSteps: 30 })!;
  assert.match(await s.read({ paths: ["gone.ts"] }), /\[10 model step\(s\) left in your budget\]$/);
  assert.match(await s.acknowledge({ files: [{ path: "src/big.ts", outcome: "skipped", reason: "budget-exhausted" }] }),
    /src\/big\.ts: REFUSED — 10 model steps remain; budget-exhausted is accepted only in the last 3/);
  assert.match(await s.acknowledge({ files: [{ path: "lib/name.ts", outcome: "skipped", reason: "mechanical-rename" }] }), /lib\/name\.ts: skipped/, "other reasons are not budget-bound");
  await step(27);
  assert.match(await s.acknowledge({ files: [{ path: "src/big.ts", outcome: "skipped", reason: "budget-exhausted" }] }), /src\/big\.ts: skipped \(budget-exhausted\)/);
  assert.match(await s.read({ paths: ["src/big.ts"] }), /\[3 model step\(s\) left in your budget\]\n\[\[truncated tool=read_change/, "the truncation marker stays last");
});
