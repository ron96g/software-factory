import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { API_VERSION } from "./model/resource.ts";
import type { FactoryEvent, Source, WorkItem } from "./model/kinds.ts";
import { FACTORY_COMMENT_MARKER, type ExternalItemHistory, type SourceConnector } from "./ports/index.ts";
import { HISTORY_MAX, JiraConnector } from "./adapters/sources/jira.ts";
import { boundHistory } from "./sources/history-bounds.ts";
import { DefaultSourceSyncer } from "./sources/syncer.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { renderSourceHistory } from "./agents/source-history.ts";

const jiraSource = (deployment: string) =>
  ({ metadata: { name: "desk" }, spec: { type: "jira", connection: { url: "https://j.example", deployment }, sync: { bidirectional: false } } }) as never;

test("ADR-0070: Data Center history pages all comments, marks internal ones, and flattens the changelog", async () => {
  const comment = (id: string, extra: object = {}) => ({ id, author: { displayName: `user-${id}` }, body: `text ${id}`, created: `2026-11-1${id}T10:00:00.000+0000`, ...extra });
  const pages = [
    [comment("1"), comment("2", { properties: [{ key: "sd.public.comment", value: { internal: true } }] })],
    [comment("3", { properties: [{ key: "sd.public.comment", value: { internal: "true" } }] }), comment("4", { visibility: { type: "role", value: "Developers" } })],
  ];
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (u.pathname === "/rest/api/2/issue/DESK-1/comment") {
      assert.equal(u.searchParams.get("expand"), "properties");
      const at = Number(u.searchParams.get("startAt"));
      return Response.json({ startAt: at, total: 4, comments: pages[at / 2] ?? [] });
    }
    if (u.pathname === "/rest/api/2/issue/DESK-1") {
      return Response.json({ changelog: { histories: [{ author: { displayName: "Agent A" }, created: "2026-11-12T09:00:00.000+0000", items: [{ field: "status", fromString: "Open", toString: "In Progress" }, { field: "assignee", fromString: null, toString: "Agent A" }] }] } });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;

  const h = await new JiraConnector({ resolve: () => "tok" }, fetchImpl).fetchHistory(jiraSource("datacenter"), "DESK-1");
  assert.deepEqual(h.comments.map((c) => [c.id, c.author, c.visibility]), [
    ["1", "user-1", "public"], ["2", "user-2", "internal"], ["3", "user-3", "internal"], ["4", "user-4", "internal"],
  ]);
  assert.deepEqual(h.changes, [
    { at: "2026-11-12T09:00:00.000Z", author: "Agent A", field: "status", from: "Open", to: "In Progress" },
    { at: "2026-11-12T09:00:00.000Z", author: "Agent A", field: "assignee", to: "Agent A" },
  ]);
  assert.equal(h.omitted, undefined);
  assert.equal(seen.filter((s) => s.includes("/comment")).length, 2, "both comment pages read");
});

test("ADR-0070: Cloud history reads ADF comments, jsdPublic and the paged changelog endpoint", async () => {
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/rest/api/3/issue/DESK-2/comment") {
      return Response.json({ total: 1, comments: [{ id: "10", author: { displayName: "Cust" }, jsdPublic: false, created: "2026-11-12T08:00:00.000+0000", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret note" }] }] } }] });
    }
    if (u.pathname === "/rest/api/3/issue/DESK-2/changelog") {
      return Response.json({ total: 1, isLast: true, values: [{ author: { displayName: "Bot" }, created: "2026-11-12T08:30:00.000+0000", items: [{ field: "priority", fromString: "Low", toString: "High" }] }] });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const h = await new JiraConnector({ resolve: () => "tok" }, fetchImpl).fetchHistory(jiraSource("cloud"), "DESK-2");
  assert.deepEqual(h.comments.map((c) => [c.body, c.visibility]), [["secret note", "internal"]]);
  assert.equal(h.changes[0].field, "priority");
});

function syncWorld(fetchHistory: () => Promise<ExternalItemHistory>) {
  let t = Date.parse("2026-11-19T10:00:00Z");
  const clock = { now: () => new Date((t += 1000)) };
  const store = new SqliteStore(new DatabaseSync(":memory:"), clock);
  let updatedAt = "1";
  const connector = {
    type: "jira",
    fetchItems: async () => [{ externalId: "DESK-1", title: "Route 404", description: "since deploy", updatedAt }],
    fetchHistory,
  } as SourceConnector;
  const syncer = new DefaultSourceSyncer({ reader: store, writer: store, connectors: { get: () => connector, keys: () => ["jira"] }, events: new StoreEventRecorder(store), clock });
  const ready = store.create<Source>({ apiVersion: API_VERSION, kind: "Source", metadata: { name: "desk", namespace: "default" }, spec: { type: "jira" } } as Source);
  const item = () => store.get<WorkItem>("WorkItem", "default", "desk-desk-1");
  const reasons = async () => (await store.list<FactoryEvent>("Event")).map((e) => e.spec.reason);
  return { syncer, store, ready, item, reasons, touch: () => (updatedAt = String(Number(updatedAt) + 1)) };
}

test("ADR-0070: an item is never imported without its history; it is imported once the history can be read", async () => {
  let fail = true;
  const history: ExternalItemHistory = {
    comments: [
      { id: "1", author: "Customer", createdAt: "2026-11-18T10:00:00.000Z", visibility: "public", body: "Still broken" },
      { id: "2", author: "Factory", createdAt: "2026-11-18T11:00:00.000Z", visibility: "public", body: `We are on it\n${FACTORY_COMMENT_MARKER}` },
    ],
    changes: [{ at: "2026-11-18T09:00:00.000Z", author: "Agent A", field: "status", from: "Open", to: "In Progress" }],
  };
  const w = syncWorld(async () => {
    if (fail) throw new Error("Jira 403: forbidden");
    return history;
  });
  await w.ready;

  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 0 });
  assert.equal(await w.item(), null, "not imported without history");
  assert.ok((await w.reasons()).includes("HistoryUnavailable"));

  fail = false;
  assert.deepEqual(await w.syncer.sync("desk"), { created: 1, updated: 0 });
  const wi = (await w.item())!;
  assert.equal(wi.spec.sourceHistory?.comments.length, 2);
  assert.equal(wi.spec.sourceHistory?.comments[1].byFactory, true);
  assert.ok(wi.spec.sourceHistory?.fetchedAt);

  // Unchanged ticket: no refetch, no update. A changed ticket whose history fails keeps the last good state.
  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 0 });
  w.touch();
  fail = true;
  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 0 });
  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 0 });
  assert.equal((await w.reasons()).filter((r) => r === "HistoryUnavailable").length, 2, "the same error warns once per episode");
  fail = false;
  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 1 }, "retried: the updated stamp was not advanced");
});

test("ADR-0070: items imported before history existed are backfilled on the next sync", async () => {
  const w = syncWorld(async () => ({ comments: [], changes: [] }));
  await w.ready;
  assert.deepEqual(await w.syncer.sync("desk"), { created: 1, updated: 0 });
  const wi = (await w.item())!;
  await w.store.update<WorkItem>({ ...wi, spec: { ...wi.spec, sourceHistory: undefined } });
  assert.deepEqual(await w.syncer.sync("desk"), { created: 0, updated: 1 });
  assert.ok((await w.item())!.spec.sourceHistory);
});

test("ADR-0070: agents get the history oldest first, internal comments flagged, newest kept when over budget", () => {
  const wi = {
    metadata: { name: "desk-desk-1" },
    spec: {
      title: "Route 404",
      sourceRef: { name: "desk" },
      externalRef: { id: "DESK-1" },
      sourceHistory: {
        fetchedAt: "2026-11-19T10:00:00.000Z",
        comments: [
          { id: "1", author: "Customer", createdAt: "2026-11-18T10:00:00.000Z", visibility: "public", body: "old ".repeat(200) },
          { id: "2", author: "Agent B", createdAt: "2026-11-18T12:00:00.000Z", visibility: "internal", body: "Known bug, ticket DEV-9" },
        ],
        changes: [{ at: "2026-11-18T11:00:00.000Z", author: "Agent A", field: "status", from: "Open", to: "In Progress" }],
      },
    },
  } as unknown as WorkItem;

  const full = renderSourceHistory(wi, 10_000);
  assert.ok(full.indexOf("old old") < full.indexOf("status: Open → In Progress") && full.indexOf("status:") < full.indexOf("Known bug"));
  assert.match(full, /INTERNAL comment/);
  assert.match(full, /never quote or reveal them/);

  const short = renderSourceHistory(wi, 300);
  assert.ok(short.includes("Known bug") && !short.includes("old old"));
  assert.match(short, /1 older entry omitted/);
});

test("ADR-0070: a Data Center changelog over the bound keeps the newest changes and counts the rest", async () => {
  const histories = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => ({
    author: { displayName: "A" }, created: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), items: [{ field: "status", fromString: `s${i}`, toString: `s${i + 1}` }],
  }));
  let changelogCalls = 0;
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/comment")) return Response.json({ total: 0, comments: [] });
    changelogCalls++;
    return Response.json({ changelog: { histories } });
  }) as typeof fetch;
  const h = await new JiraConnector({ resolve: () => "tok" }, fetchImpl).fetchHistory(jiraSource("datacenter"), "DESK-1");
  assert.equal(changelogCalls, 1);
  assert.equal(h.changes.length, HISTORY_MAX);
  assert.equal(h.changes.at(-1)?.to, `s${HISTORY_MAX + 5}`);
  assert.deepEqual(h.omitted, { changes: 5 });
});

test("ADR-0070: the stored history is bounded in total size, newest kept", () => {
  const big = (id: string, day: number) => ({ id, author: "x", createdAt: `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`, visibility: "public" as const, body: "y".repeat(1000) });
  const h = boundHistory({ fetchedAt: "t", comments: [big("1", 1), big("2", 2), big("3", 3)], changes: [] }, 2300);
  assert.deepEqual(h.comments.map((c) => c.id), ["2", "3"]);
  assert.deepEqual(h.omitted, { comments: 1 });
});

test("ADR-0070: an oversized newest entry is clipped to the budget; factory internal replies stay marked INTERNAL", () => {
  const wi = {
    metadata: { name: "w" },
    spec: { title: "t", sourceRef: { name: "desk" }, sourceHistory: { fetchedAt: "t", changes: [], comments: [
      { id: "1", author: "Factory", createdAt: "2026-11-18T10:00:00.000Z", visibility: "internal", body: "z".repeat(20_000), byFactory: true },
    ] } },
  } as unknown as WorkItem;
  const out = renderSourceHistory(wi, 6000);
  assert.ok(out.length < 6600, `bounded (${out.length})`);
  assert.match(out, /factory · INTERNAL comment/);
  assert.match(out, /truncated for length/);
});
