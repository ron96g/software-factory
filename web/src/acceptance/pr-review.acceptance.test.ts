import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { testDefinitions } from "../core/testing/definitions.ts";
import { GitWorktreeWorkspaces } from "../core/adapters/workspaces/git-worktree.ts";
import { EnvSecretResolver } from "../core/adapters/secrets/env.ts";
import { ANONYMOUS as p, type DefinitionLoader, type WorkItemDetail } from "../core/ports/index.ts";
import type { Repository, Source } from "../core/model/kinds.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const detail = (f: Factory, name: string) => f.app.getWorkItem(p, name) as Promise<WorkItemDetail>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

/** A remote with `main` and a pull request head at `refs/pull/7/head`, plus the operator's clone. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-"));
  const remote = join(dir, "remote");
  git(dir, "init", "-q", remote);
  writeFileSync(join(remote, "app.ts"), "export const answer = 41;\n");
  git(remote, "add", ".");
  git(remote, "commit", "-qm", "base");
  git(remote, "checkout", "-qb", "feature");
  writeFileSync(join(remote, "app.ts"), "export const answer = 42; // fixed\n");
  git(remote, "commit", "-qam", "fix answer");
  const head = git(remote, "rev-parse", "HEAD");
  git(remote, "update-ref", "refs/pull/7/head", head);
  git(remote, "checkout", "-q", "main");
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", `file://${remote}`, clone);
  return { dir, remote, clone, head };
}

test("X72 pull request review (ADR-0094)", async (t) => {
  const repo = fixtureRepo();
  const loader: DefinitionLoader = {
    async load() {
      return (await testDefinitions().load()).map((r) => {
        if (r.kind === "Repository" && r.metadata.name === "software-factory") {
          return { ...r, spec: { local: { path: repo.clone }, git: { url: `file://${repo.remote}`, defaultBranch: "main" } } } as Repository;
        }
        if (r.kind === "Source" && r.metadata.name === "github-pull-requests") {
          const s = r as Source;
          return { ...s, spec: { ...s.spec, writeBack: { pullRequestReviews: ["comment", "request-changes"] } } } as Source;
        }
        return r;
      });
    },
  };

  const reviews: { id: number; body: string; event: string; commit_id: string; comments?: { path: string; line: number; side: string; body: string }[] }[] = [];
  let posts = 0;
  let reviewerCalls = 0;
  const prompts: string[] = [];
  let pulls = [{ number: 7, html_url: "https://github.com/ron96g/software-factory/pull/7", title: "Fix the answer", body: "Sets answer to 42.",
    labels: [{ name: "factory-review" }], updated_at: "2026-11-26T10:00:00Z", head: { sha: repo.head }, base: { ref: "main" } }];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.host === "api.github.com") {
      if (u.pathname === "/repos/ron96g/software-factory/pulls") return Response.json(pulls);
      if (u.pathname === "/repos/ron96g/software-factory/pulls/7/reviews") {
        if (init?.method !== "POST") return Response.json(reviews.map((r) => ({ id: r.id, body: r.body, state: r.event, html_url: `https://gh/r/${r.id}` })));
        posts++;
        const b = JSON.parse(String(init.body));
        reviews.push({ id: 100 + posts, ...b });
        // The first post reaches GitHub but its response is lost: the retry must find it instead of posting again.
        if (posts === 1) return new Response("bad gateway", { status: 502 });
        return Response.json({ id: 100 + posts, html_url: `https://gh/r/${100 + posts}` });
      }
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init?.body));
    const system = String(body.messages[0].content);
    prompts.push(body.messages.map((m: { content?: string }) => m.content ?? "").join("\n"));
    const finish = (args: unknown) => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "f", type: "function", function: { name: "finish", arguments: JSON.stringify(args) } }] } }] });
    if (system.includes("## Skill: code-review")) {
      reviewerCalls++;
      const finding = { severity: "blocking", path: "app.ts", line: 1, message: "No test covers the new value." };
      // The first answer contradicts itself (accepted despite a blocking finding); the schema rejects it in the run.
      const outside = { severity: "non-blocking", path: "app.ts", line: 30, message: "Consider documenting the constant." };
      const fileLevel = { severity: "non-blocking", path: "README.md", message: "The README still mentions 41." };
      const suggested = { ...finding, suggestion: "export const answer = 42; // covered by app.test.ts" };
      const report = reviewerCalls === 1
        ? { verdict: "accepted", summary: "The fix changes the exported constant.", rationale: "Looks fine to merge as it is.", accepted: ["The new value"], requiredChanges: [], findings: [finding] }
        : reviewerCalls === 2
        ? { verdict: "rejected", summary: "The fix changes the exported constant without a test.", rationale: "An untested change to a public constant cannot be merged.",
            accepted: ["The new value itself is correct"], requiredChanges: ["Add a test for answer in app.test.ts"], findings: [finding, outside] }
        : { verdict: "rejected", summary: "The fix changes the exported constant without a test.", rationale: "An untested change to a public constant cannot be merged.",
            accepted: ["The new value itself is correct"], requiredChanges: ["Add a test for answer in app.test.ts"], findings: [suggested, fileLevel] };
      return finish({ summary: "reviewed", outcome: report.verdict, artifacts: [{ type: "pr-review-report", content: JSON.stringify(report) }], questions: [] });
    }
    if (system.includes("## Skill: change-explanation")) {
      const explanation = "## In one paragraph\nThe answer becomes correct.\n\n```mermaid\nflowchart LR\n  A[caller] --> B[answer 41 to 42]\n```\n\n## Worked example\nBefore: 41. After: 42.";
      return finish({ summary: "explained", artifacts: [{ type: "pr-explanation", content: explanation }], questions: [] });
    }
    return finish({ summary: "researched", artifacts: [{ type: "research-notes", content: "## Summary\n`answer` is defined in `software-factory:app.ts:1`." }], questions: [] });
  }) as typeof fetch;

  const secrets = new EnvSecretResolver({});
  const f = await createFactory({ definitionsRoot: ROOT, definitionLoader: loader, databasePath: ":memory:", fetch: fetchImpl, log: () => {},
    workspaceBackend: new GitWorktreeWorkspaces({ definitionsRoot: repo.dir, workspacesDir: join(repo.dir, "ws"), secrets }),
    env: { FACTORY_AGENT_RUNTIME: "tool-loop", FACTORY_SANDBOX_RUNTIME: "none", OPENAI_API_KEY: "sk-test-123456", GITHUB_TOKEN: "gh-test-token" } });
  await f.start();
  const name = "github-pull-requests-7";
  let d: WorkItemDetail;
  try {
    await t.test("AC-1: a labelled pull request becomes a pr-review item pinned at its head; unlabelled ones are ignored", async () => {
      pulls = [...pulls, { ...pulls[0], number: 8, labels: [] }];
      assert.deepEqual(await f.app.syncSource(p, "github-pull-requests"), { created: 1, updated: 0 });
      d = await detail(f, name);
      assert.deepEqual(d.workItem.spec.pullRequest, { number: 7, headSha: repo.head, baseRef: "main" });
      assert.equal(d.workItem.spec.workflowRef?.name, "pr-review");
      assert.ok(d.capabilities?.includes("pr-review"));
    });

    await t.test("AC-2: the reviewer sees exactly the pull request's diff against its merge-base", async () => {
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.stage === "review-verdict" && x.workItem.status.phase === "AwaitingApproval" && x; }, "review-verdict");
      const reviewerPrompt = prompts.find((x) => x.includes("## Skill: code-review"))!;
      assert.match(reviewerPrompt, /Pull request #7 in software-factory/);
      assert.match(reviewerPrompt, /\+export const answer = 42; \/\/ fixed/);
      assert.match(reviewerPrompt, /-export const answer = 41;/);
      assert.ok(d.artifacts.some((a) => a.spec.artifactTypeRef.name === "pr-review-report"));
    });

    await t.test("AC-2c: the verdict is accepted, partially accepted or rejected, and must agree with the findings", async () => {
      assert.equal(reviewerCalls, 3, "a contradictory verdict, then a line outside the diff, were sent back in the same run");
      assert.match(prompts.at(-1)!, /findings\[1\] \(app\.ts:30\): app\.ts:30 is outside the changed hunks/);
      const report = JSON.parse(d.artifacts.find((a) => a.spec.artifactTypeRef.name === "pr-review-report")!.spec.content);
      assert.equal(report.verdict, "rejected");
      assert.deepEqual(report.requiredChanges, ["Add a test for answer in app.test.ts"]);
    });

    await t.test("AC-2b: a plain-language explanation with a diagram and an example is ready at the gate, grounded in the diff", async () => {
      const explainerPrompt = prompts.find((x) => x.includes("## Skill: change-explanation"))!;
      assert.match(explainerPrompt, /\+export const answer = 42;/, "the explainer sees the diff");
      const explanation = d.artifacts.find((a) => a.spec.artifactTypeRef.name === "pr-explanation");
      assert.match(explanation?.spec.content ?? "", /```mermaid[\s\S]*Worked example/);
      assert.match(prompts.find((x) => x.includes("## Skill: code-review"))!, /Worked example/, "the reviewer gets the explanation as input");
    });

    await t.test("AC-3: nothing is posted before approval; a verdict override outside the item or the permission is refused", async () => {
      assert.equal(posts, 0);
      await assert.rejects(f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "reject", "x", false, "partially-accepted"), /only be set when approving/);
    });

    await t.test("AC-4: approval posts one review at the pinned head, even when the first response is lost", async () => {
      await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "approve", undefined, false, "partially-accepted");
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.phase === "Done" && x; }, "Done after publication", 30_000);
      assert.equal(reviews.length, 1, "exactly one review exists on the pull request");
      assert.equal(reviews[0].event, "REQUEST_CHANGES", "partially accepted blocks the merge until the required changes are made");
      assert.equal(reviews[0].commit_id, repo.head);
      assert.match(reviews[0].body, /^## Verdict: Partially accepted\n\n_Set by [^;]+; the agent proposed Rejected\._[\s\S]*### Required changes\n- Add a test for answer/);
      assert.doesNotMatch(reviews[0].body, /mermaid/, "the explanation is for the human reviewer, not posted");
    });

    await t.test("AC-6: line findings are inline comments of the same review; file-level findings stay in its body", async () => {
      const [review] = reviews;
      assert.equal(review.comments?.length, 1);
      assert.deepEqual({ ...review.comments![0], body: undefined }, { path: "app.ts", line: 1, side: "RIGHT", body: undefined });
      assert.match(review.comments![0].body, /^\*\*Blocking:\*\* No test covers the new value\.\n\n```suggestion\nexport const answer = 42; \/\/ covered by app\.test\.ts\n```$/);
      assert.match(review.body, /### Other non-blocking findings\n- `README\.md` The README still mentions 41\./);
      assert.match(review.body, /_1 finding is commented inline\._/);
      assert.doesNotMatch(review.body, /No test covers/, "an inline finding is not repeated in the body");
    });

    await t.test("AC-5: a new head is recorded but never restarts the reviewed item", async () => {
      pulls = [{ ...pulls[0], head: { sha: "f".repeat(40) }, updated_at: "2026-11-26T11:00:00Z" }];
      await f.app.syncSource(p, "github-pull-requests");
      d = await detail(f, name);
      assert.equal(d.workItem.spec.pullRequest?.headSha, "f".repeat(40));
      assert.equal(d.workItem.status?.phase, "Done");
    });
  } finally { await f.stop(); }
});
