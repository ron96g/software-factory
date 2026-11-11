import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS, FACTORY_COMMENT_MARKER } from "./ports/index.ts";
import { adfToText } from "./adapters/sources/jira.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

async function withFactory(fetchImpl: typeof fetch, fn: (f: Factory) => Promise<void>) {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, fetch: fetchImpl, commentPollMs: 30, log: () => {} });
  await f.start();
  try {
    await fn(f);
  } finally {
    await f.stop();
  }
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Minimal in-memory GitHub Issues API. */
function fakeGithub(opts: { failFirstPost?: boolean } = {}) {
  const comments: { user: { login: string }; body: string; created_at: string }[] = [];
  let posts = 0;
  let failed = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/repos/acme/shop/issues") {
      return Response.json([{ number: 42, html_url: "https://gh/42", title: "Checkout slow", body: "slow", labels: [], updated_at: "t1" }]);
    }
    if (u.pathname === "/repos/acme/shop/issues/42/comments" && init?.method === "POST") {
      posts++;
      if (opts.failFirstPost && !failed) {
        failed = true;
        return new Response("boom", { status: 502 });
      }
      comments.push({ user: { login: "factory-bot" }, body: JSON.parse(String(init.body)).body, created_at: new Date().toISOString() });
      return Response.json({}, { status: 201 });
    }
    if (u.pathname === "/repos/acme/shop/issues/42/comments") return Response.json(comments);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, comments, posts: () => posts, reply: (login: string, body: string) => comments.push({ user: { login }, body, created_at: new Date(Date.now() + 5).toISOString() }) };
}

test("W1–W3: questions go out via the outbox (retried, once), a reply on the issue unblocks the item", async () => {
  const gh = fakeGithub({ failFirstPost: true });
  await withFactory(gh.fetchImpl, async (f) => {
    await f.app.syncSource(p, "github-issues");
    const name = "github-issues-42";
    await waitFor(async () => (await f.app.getWorkItem(p, name))?.workItem.status?.phase === "Blocked", "blocked");

    // first delivery fails (502), retry succeeds; exactly one comment posted
    await waitFor(async () => gh.comments.length === 1, "comment delivered", 15_000);
    assert.equal(gh.posts(), 2);
    assert.ok(gh.comments[0].body.includes("needs more information"));
    assert.ok(gh.comments[0].body.includes(FACTORY_COMMENT_MARKER), "echo-suppression marker");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(gh.comments.length, 1, "not delivered twice");

    // the factory's own comment must not count as an answer
    const d0 = await f.app.getWorkItem(p, name);
    assert.ok(!d0?.clarifications[0].spec.answers?.length);

    gh.reply("alice", "Checkout takes 8s for EU customers since Monday. P1.");
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.workItem.status?.stage !== "triage" ? x : undefined;
    }, "resumed past triage");
    const c = d.clarifications[0];
    assert.match(c.spec.answers![0], /8s for EU/);
    assert.equal(c.spec.answeredBy, "github-issues:alice");
    assert.ok(d.events.some((e) => e.spec.reason === "AnsweredAtSource"));
  });
});

test("W4: Jira connector fetches (JQL), comments (ADF) and reads replies", async () => {
  const comments: { author: { displayName: string }; body: unknown; created: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/rest/api/3/search/jql") {
      assert.match(u.searchParams.get("jql") ?? "", /project = SHOP/);
      return Response.json({
        issues: [
          {
            key: "SHOP-7",
            self: "x",
            fields: {
              summary: "Refund button missing",
              description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "On mobile" }] }] },
              labels: ["factory"],
              priority: { name: "High" },
              updated: "2026-11-11T10:00:00.000+0000",
            },
          },
        ],
      });
    }
    if (u.pathname === "/rest/api/3/issue/SHOP-7/comment" && init?.method === "POST") {
      comments.push({ author: { displayName: "Factory" }, body: JSON.parse(String(init.body)).body, created: new Date().toISOString() });
      return Response.json({}, { status: 201 });
    }
    if (u.pathname === "/rest/api/3/issue/SHOP-7/comment") return Response.json({ comments });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;

  await withFactory(fetchImpl, async (f) => {
    assert.deepEqual(await f.app.syncSource(p, "jira-main"), { created: 1, updated: 0 });
    const name = "jira-main-shop-7";
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.workItem.status?.phase === "Blocked" ? x : undefined;
    }, "blocked");
    assert.equal(d.workItem.spec.description, "On mobile");
    assert.equal(d.workItem.spec.externalRef?.url, "https://acme.atlassian.net/browse/SHOP-7");
    await waitFor(async () => comments.length === 1, "jira comment");
    assert.match(adfToText(comments[0].body as never), /needs more information/);
    comments.push({ author: { displayName: "Bob" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Only iOS, P2" }] }] }, created: new Date(Date.now() + 5).toISOString() });
    const after = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.clarifications[0]?.spec.answers?.length ? x : undefined;
    }, "answered from jira");
    assert.equal(after.clarifications[0].spec.answeredBy, "jira-main:Bob");
  });
});

test("W5: re-run creates a replay with pinned inputs; workflow state unchanged; replay artifacts not used", async () => {
  await withFactory(fetch, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Replay me", description: "x" });
    const before = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      return x?.workItem.status?.phase === "Blocked" ? x : undefined;
    }, "blocked");
    const research = before.runs.find((r) => r.spec.step === "research-impact")!;
    const triage = before.runs.find((r) => r.spec.step === "triage-signal")!;

    const replay = await f.app.rerun(p, triage.metadata.name);
    assert.equal(replay.spec.replayOf?.name, triage.metadata.name);
    const done = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      const r = x?.runs.find((y) => y.metadata.name === replay.metadata.name);
      return r?.status?.phase === "Succeeded" ? { x, r } : undefined;
    }, "replay done");
    assert.equal(done.r.status?.provenance?.replayOf?.name, triage.metadata.name);
    assert.deepEqual(Object.keys(done.r.status!.provenance!.inputs), Object.keys(triage.status!.provenance!.inputs));
    assert.equal(done.x!.workItem.status?.phase, "Blocked");
    assert.equal(done.x!.workItem.metadata.resourceVersion, before.workItem.metadata.resourceVersion, "work item untouched");
    assert.ok(done.x!.artifacts.some((a) => a.metadata.labels?.["factory.ai-dlc.io/replay"]));

    await assert.rejects(f.app.rerun(p, replay.metadata.name), /original/);
    assert.ok(research);
  });
});
