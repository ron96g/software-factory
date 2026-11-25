import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubCodeHost } from "./github.ts";
import type { Repository } from "../../model/kinds.ts";
import type { PullRequestInput, SecretResolver } from "../../ports/index.ts";

const repo = {
  kind: "Repository", metadata: { name: "widgets", namespace: "default" },
  spec: { git: { url: "https://github.com/acme/widgets.git", defaultBranch: "main", secretRef: { name: "github-token" } } },
} as unknown as Repository;
const secrets = { resolve: () => "test-token" } as unknown as SecretResolver;
const input: PullRequestInput = { head: "factory/item", base: "main", title: "A feature", body: "### Verification\n\n**Verdict: partial**", draft: true };
const existing = (over: Partial<{ title: string; body: string | null }> = {}) =>
  [{ html_url: "https://github.com/acme/widgets/pull/12", number: 12, title: "A feature", body: "### Verification\n\n**Verdict: partial**", ...over }];

function fakeFetch(existingPrs: unknown[]) {
  const calls: { method: string; path: string; body?: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({ method: init.method ?? "GET", path, ...(init.body ? { body: String(init.body) } : {}) });
    if (path.includes("/pulls?state=open")) return Response.json(existingPrs);
    if (init.method === "PATCH") return Response.json({ html_url: "https://github.com/acme/widgets/pull/12", number: 12 });
    return Response.json({ html_url: "https://github.com/acme/widgets/pull/9", number: 9 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("reusing an open PR refreshes its title and body (ADR-0054) so the description is current", async () => {
  const { f, calls } = fakeFetch(existing({ body: "### Verification\n\n{\"verdict\":\"partial\",\"traceMatrix\":[...]}" }));
  const host = new GithubCodeHost(secrets, f);
  const result = await host.openPullRequest(repo, input);
  assert.deepEqual(result, { url: "https://github.com/acme/widgets/pull/12", number: 12, created: false });
  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "the existing PR is updated");
  assert.equal(patch!.path, "/repos/acme/widgets/pulls/12");
  assert.deepEqual(JSON.parse(patch!.body!), { title: input.title, body: input.body });
});

test("an unchanged description is not re-written (idempotent re-delivery must not churn the PR)", async () => {
  const { f, calls } = fakeFetch(existing());
  const host = new GithubCodeHost(secrets, f);
  await host.openPullRequest(repo, input);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0, "no PATCH when nothing changed");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no new PR either");
});

test("with no open PR for the head branch a draft PR is created", async () => {
  const { f, calls } = fakeFetch([]);
  const host = new GithubCodeHost(secrets, f);
  const result = await host.openPullRequest(repo, input);
  assert.deepEqual(result, { url: "https://github.com/acme/widgets/pull/9", number: 9, created: true });
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post!.body!), { head: "factory/item", base: "main", title: "A feature", body: input.body, draft: true });
});
