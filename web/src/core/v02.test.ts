import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS, FACTORY_COMMENT_MARKER } from "./ports/index.ts";
import { JiraConnector } from "./adapters/sources/jira.ts";
import { createOutboxController } from "./runtime/outbox.ts";
import type { OutboxMessage } from "./model/kinds.ts";

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
    if (u.pathname === "/repos/ron96g/software-factory/issues") {
      return Response.json([{ number: 42, html_url: "https://gh/42", title: "Checkout slow", body: "slow", labels: [], updated_at: "t1" }]);
    }
    if (u.pathname === "/repos/ron96g/software-factory/issues/42/comments" && init?.method === "POST") {
      posts++;
      if (opts.failFirstPost && !failed) {
        failed = true;
        return new Response("boom", { status: 502 });
      }
      comments.push({ user: { login: "factory-bot" }, body: JSON.parse(String(init.body)).body, created_at: new Date().toISOString() });
      return Response.json({}, { status: 201 });
    }
    if (u.pathname === "/repos/ron96g/software-factory/issues/42/comments") return Response.json(comments);
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

test("W4: Jira (Data Center) fetches via JQL, comments as plain text and reads replies", async () => {
  const comments: { author: { displayName: string }; body: unknown; created: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/rest/api/2/search") {
      assert.match(u.searchParams.get("jql") ?? "", /labels = factory/);
      return Response.json({
        issues: [
          {
            key: "SHOP-7",
            self: "x",
            fields: { summary: "Refund button missing", description: "On mobile", labels: ["factory"], priority: { name: "High" }, updated: "2026-11-11T10:00:00.000+0000" },
          },
        ],
      });
    }
    if (u.pathname === "/rest/api/2/issue/SHOP-7/comment" && init?.method === "POST") {
      comments.push({ author: { displayName: "Factory" }, body: JSON.parse(String(init.body)).body, created: new Date().toISOString() });
      return Response.json({}, { status: 201 });
    }
    if (u.pathname === "/rest/api/2/issue/SHOP-7/comment") return Response.json({ comments });
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
    assert.equal(d.workItem.spec.externalRef?.url, "https://jira.telekom.de/browse/SHOP-7");
    await waitFor(async () => comments.length === 1, "jira comment");
    assert.equal(typeof comments[0].body, "string");
    assert.match(comments[0].body as string, /needs more information/);
    comments.push({ author: { displayName: "Bob" }, body: "Only iOS, P2", created: new Date(Date.now() + 5).toISOString() });
    const after = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.workItem.status?.stage !== "triage" ? x : undefined;
    }, "resumed past triage");
    assert.equal(after.clarifications[0].spec.answeredBy, "jira-main:Bob");
  });
});

test("W4: Jira auth and body format per deployment (cloud: basic + ADF, datacenter: bearer PAT + text)", async () => {
  const calls: { path: string; auth: string | null; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)).body : undefined });
    return Response.json({}, { status: 201 });
  }) as typeof fetch;
  const connector = new JiraConnector({ resolve: () => "tok" }, fetchImpl);
  const source = (deployment: string) =>
    ({ metadata: { name: "j" }, spec: { type: "jira", connection: { url: "https://j.example", deployment, email: "a@b.c", secretRef: { name: "jira-token" } }, sync: { bidirectional: true } } }) as never;

  await connector.postComment(source("cloud"), "X-1", "hi");
  await connector.postComment(source("datacenter"), "X-1", "hi");
  assert.deepEqual(calls[0], { path: "/rest/api/3/issue/X-1/comment", auth: `Basic ${Buffer.from("a@b.c:tok").toString("base64")}`, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } });
  assert.deepEqual(calls[1], { path: "/rest/api/2/issue/X-1/comment", auth: "Bearer tok", body: "hi" });
  await assert.rejects(connector.postComment(source("onprem"), "X-1", "hi"), /unknown connection.deployment/);
});

test("read-only source: the Jira connector refuses writes and the outbox never delivers to it", async () => {
  const readOnly = { metadata: { name: "ro", namespace: "factory-system" }, spec: { type: "jira", connection: { url: "https://j.example", deployment: "datacenter" }, sync: { bidirectional: false } } } as never;
  let requests = 0;
  const connector = new JiraConnector({ resolve: () => "tok" }, (async () => (requests++, Response.json({}))) as typeof fetch);
  await assert.rejects(connector.postComment(readOnly, "X-1", "hi"), /read-only/);
  assert.equal(requests, 0);

  let msg = { apiVersion: "x", kind: "OutboxMessage", metadata: { name: "m", namespace: "default" }, spec: { sourceRef: { name: "ro" }, externalId: "X-1", action: "comment", payload: { body: "q" } }, status: { phase: "Pending" } } as never as OutboxMessage;
  let delivered = 0;
  const warnings: string[] = [];
  const controller = createOutboxController({
    reader: { get: async (kind: string) => (kind === "OutboxMessage" ? msg : kind === "Source" ? readOnly : null), list: async () => [] } as never,
    status: { updateStatus: async (o: OutboxMessage) => (msg = o) } as never,
    events: { normal: async () => {}, warning: async (_o: unknown, reason: string) => void warnings.push(reason) } as never,
    clock: { now: () => new Date() },
    handlers: { get: () => ({ action: "comment", deliver: async () => void delivered++ }) } as never,
    redactor: { redact: (x: string) => x } as never,
  });
  assert.equal(await controller.reconcile("default/m"), undefined, "no retry");
  assert.equal(delivered, 0);
  assert.equal(msg.status?.phase, "Failed");
  assert.match(msg.status?.lastError ?? "", /read-only/);
  assert.deepEqual(warnings, ["DeliveryBlocked"]);
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
