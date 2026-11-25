import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestHandler } from "./publish.ts";
import type { Artifact, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import type { BaseConflictDetector, BranchPublisher, CodeHost, ResourceReader } from "../ports/index.ts";

const NS = "default";

function fixture(verificationContent: string, verificationFormat?: "json") {
  const ws = { kind: "Workspace", metadata: { name: "ws", namespace: NS }, spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" }, status: { phase: "Ready", path: "/ws", baseCommit: "base1234567" } } as unknown as Workspace;
  const repo = { kind: "Repository", metadata: { name: "repo", namespace: NS }, spec: { git: { url: "https://example.invalid/repo.git", defaultBranch: "main" } } } as unknown as Repository;
  const wi = { kind: "WorkItem", metadata: { name: "item", namespace: NS }, spec: { title: "A feature", description: "Does a thing." } } as unknown as WorkItem;
  const artifacts = [
    { kind: "Artifact", metadata: { name: "spec" }, spec: { artifactTypeRef: { name: "spec" }, content: "# Spec" } },
    { kind: "Artifact", metadata: { name: "vr" }, spec: { artifactTypeRef: { name: "verification-report" }, content: verificationContent, ...(verificationFormat ? { format: verificationFormat } : {}) } },
  ] as unknown as Artifact[];
  const reader = {
    get: async (_kind: string) => (_kind === "Workspace" ? ws : _kind === "Repository" ? repo : _kind === "WorkItem" ? wi : null),
    list: async (_kind: string) => (_kind === "Artifact" ? artifacts : []),
  } as unknown as ResourceReader;
  let body = "";
  const publisher: BranchPublisher = { publish: async (w) => ({ branch: w.spec.branch, commit: "head456", pushed: true }) };
  const conflicts: BaseConflictDetector = { detect: async () => ({ conflicts: [], baseCommit: "base1234567" }) };
  const codeHosts: CodeHost[] = [{ type: "github", matches: () => true, openPullRequest: async (_r, input) => { body = input.body; return { url: "https://example.invalid/pr/1", number: 1, created: true }; } }];
  return { handler: pullRequestHandler({ reader, publisher, codeHosts, conflicts }), body: () => body };
}

test("the PR body renders a JSON verification-report as Markdown, never as raw JSON", async () => {
  const { handler, body } = fixture(JSON.stringify({
    verdict: "partial",
    summary: "All configured checks are green.",
    traceMatrix: [{ criterion: "AC-1", requirement: "Returns 200 with an ETag", result: "pass", evidence: "controller_test.go:107" }],
  }), "json");
  await handler.deliver({ namespace: NS, payload: { workspace: "ws" } });
  const pr = body();
  assert.match(pr, /### Verification/);
  assert.match(pr, /\*\*Verdict: partial\*\*/);
  assert.match(pr, /\| AC-1 \| ✅ pass \|/);
  assert.doesNotMatch(pr, /"traceMatrix"/, "the raw JSON is not embedded");
  assert.doesNotMatch(pr, /\{"verdict"/, "the raw JSON is not embedded");
});

test("non-report verification content is used verbatim (the renderer never drops it)", async () => {
  const { handler, body } = fixture("### Legacy report\n\nAll good.");
  await handler.deliver({ namespace: NS, payload: { workspace: "ws" } });
  assert.match(body(), /### Legacy report\n\nAll good\./);
});
