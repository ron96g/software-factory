import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubPullRequestConnector } from "../adapters/sources/connectors.ts";
import type { Source } from "../model/kinds.ts";

const source = { metadata: { name: "prs" }, spec: { type: "github-pr", connection: { repo: "o/r" } } } as unknown as Source;
const review = { commitSha: "a".repeat(40), event: "REQUEST_CHANGES" as const, body: "inline body", fallbackBody: "all in body", marker: "<!-- m -->",
  comments: [{ path: "a.ts", line: 3, side: "RIGHT" as const, body: "**Blocking:** x" }] };

function github(reject: (b: { event: string; comments?: unknown[] }) => boolean) {
  const posted: { event: string; body: string; comments?: unknown[] }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json([]);
    const b = JSON.parse(String(init.body));
    if (reject(b)) return new Response("Unprocessable", { status: 422 });
    posted.push(b);
    return Response.json({ id: 9, html_url: "https://gh/r/9" });
  }) as typeof fetch;
  return { connector: new GithubPullRequestConnector({ resolve: () => undefined }, f), posted };
}

test("inline comments go with the verdict in one review", async () => {
  const { connector, posted } = github(() => false);
  const r = await connector.publishReview(source, "7", review);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].comments, review.comments);
  assert.equal(posted[0].body, "inline body\n\n<!-- m -->");
  assert.deepEqual({ event: r.event, inline: r.inlineComments }, { event: "REQUEST_CHANGES", inline: 1 });
});

test("a comment GitHub can't place falls back to one review with every finding in the body", async () => {
  const { connector, posted } = github((b) => !!b.comments);
  const r = await connector.publishReview(source, "7", review);
  assert.deepEqual(posted.map((p) => [p.event, p.comments, p.body]), [["REQUEST_CHANGES", undefined, "all in body\n\n<!-- m -->"]]);
  assert.equal(r.inlineComments, 0);
});

test("on the token owner's own pull request the review is a comment, still with its inline comments", async () => {
  const { connector, posted } = github((b) => b.event !== "COMMENT");
  const r = await connector.publishReview(source, "7", review);
  assert.equal(posted.length, 1);
  assert.equal(r.event, "COMMENT");
  assert.equal(r.inlineComments, 1);
});
