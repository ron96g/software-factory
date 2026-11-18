import assert from "node:assert/strict";
import { test } from "node:test";
import { createIssueProposalController, createKey, LOOKUP_DELAYS_MS } from "./controller.ts";
import { createIssueHandler, issueMarker } from "./handler.ts";
import { issueContentHash } from "./admission.ts";
import type { IssueProposal, OutboxMessage } from "../model/kinds.ts";

const NS = "default";
function setup(opts: { found?: () => { externalId: string }[] } = {}) {
  const store = new Map<string, any>();
  const k = (kind: string, name: string) => `${kind}/${name}`;
  const put = (o: any) => store.set(k(o.kind, o.metadata.name), o);
  const t = { now: Date.parse("2026-01-01T00:00:00Z") };
  const enqueued: any[] = [];
  put({ kind: "Source", metadata: { name: "gh", namespace: NS }, spec: { type: "github", writeBack: { issues: {} } } });
  const calls = { create: 0, find: 0 };
  const connector = { type: "github", createIssue: async () => { calls.create++; return { externalId: "7" }; }, findCreatedIssues: async () => { calls.find++; return opts.found?.() ?? []; } };
  const reader: any = { get: async (kind: string, _n: string, name: string) => store.get(k(kind, name)) ?? null, list: async (kind: string) => [...store.values()].filter((o) => o.kind === kind) };
  const c = createIssueProposalController({
    reader, clock: { now: () => new Date(t.now) },
    status: { updateStatus: async (o: any) => { put(o); return o; } } as any,
    events: { normal: async () => {}, warning: async () => {} },
    outbox: { enqueue: async (m: any) => { enqueued.push(m); if (!store.has(k("OutboxMessage", m.key))) put({ kind: "OutboxMessage", metadata: { name: m.key, namespace: NS }, spec: m, status: { phase: "Pending", attempts: 0 } }); } },
    connectors: { get: () => connector as any, keys: () => ["github"] },
  });
  const spec: IssueProposal["spec"] = { purpose: "finding", title: "t", body: "b", targetRef: { name: "gh" } };
  put({ apiVersion: "x", kind: "IssueProposal", metadata: { name: "p", namespace: NS, uid: "u1" }, spec: { ...spec, review: { decision: "approve", contentHash: issueContentHash(spec), at: "2026-01-01T00:00:00Z", by: "h" } } });
  const p = () => store.get("IssueProposal/p") as IssueProposal;
  const msg = () => store.get(k("OutboxMessage", createKey("p", 1))) as OutboxMessage;
  return { c, p, msg, t, enqueued, calls, connector, reader, store };
}

test("approval claims before enqueueing, then creates once and records externalRef", async () => {
  const s = setup();
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Creating");
  assert.equal(s.enqueued.length, 0);
  await s.c.reconcile("default/p");
  assert.equal(s.enqueued[0].key, "p-create-a1");
  s.msg().status = { phase: "Delivered", attempts: 1, result: { externalId: "7", url: "u" } };
  await s.c.reconcile("default/p");
  assert.deepEqual(s.p().status?.externalRef, { externalId: "7", url: "u" });
  assert.equal(s.p().status?.phase, "Created");
});

test("a stale approval hash is ignored", async () => {
  const s = setup();
  s.p().spec.title = "changed";
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Proposed");
  assert.equal(s.enqueued.length, 0);
});

test("policy block fails with the reason and nothing sent", async () => {
  const s = setup();
  await s.c.reconcile("default/p"); await s.c.reconcile("default/p");
  s.msg().status = { phase: "Failed", attempts: 0, lastError: "not permitted; nothing was sent" };
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Failed");
  assert.equal(s.calls.create, 0);
});

test("unknown outcome: lookups at 1/5/15 minutes, then Uncertain; never re-POSTs", async () => {
  const s = setup();
  await s.c.reconcile("default/p"); await s.c.reconcile("default/p");
  s.msg().status = { phase: "Failed", attempts: 1, lastError: "boom" };
  await s.c.reconcile("default/p");
  assert.equal(s.calls.find, 0);
  for (const d of LOOKUP_DELAYS_MS) {
    s.t.now = Date.parse("2026-01-01T00:00:00Z") + d;
    await s.c.reconcile("default/p");
  }
  assert.equal(s.calls.find, 3);
  assert.equal(s.p().status?.phase, "Uncertain");
  assert.equal(s.calls.create, 0);
  assert.deepEqual([...new Set(s.enqueued.map((m) => m.key))], ["p-create-a1"]);
});

test("exactly one verified match becomes Created", async () => {
  const s = setup({ found: () => [{ externalId: "9" }] });
  await s.c.reconcile("default/p"); await s.c.reconcile("default/p");
  s.msg().status = { phase: "Failed", attempts: 1 };
  await s.c.reconcile("default/p");
  s.t.now += LOOKUP_DELAYS_MS[0];
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Created");
  assert.equal(s.p().status?.externalRef?.externalId, "9");
});

test("resolutions: create-again and link are consumed once", async () => {
  const s = setup();
  s.p().status = { phase: "Uncertain", attempt: 1, approved: { contentHash: "h", at: "a" } };
  s.p().spec.resolution = { action: "create-again", at: "t1" };
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Creating");
  assert.equal(s.p().status?.attempt, 2);
  s.p().status = { ...s.p().status!, phase: "Failed" };
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.attempt, 2);
  s.p().spec.resolution = { action: "link", externalId: "42", at: "t2" };
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Created");
  assert.equal(s.p().status?.externalRef?.externalId, "42");
});

test("handler: deliver creates with marker; recover only looks up and throws when nothing found", async () => {
  const s = setup();
  await s.c.reconcile("default/p");
  const approved = s.p().status!.approved!;
  const drafts: any[] = [];
  s.connector.createIssue = (async (_s: unknown, d: any) => { drafts.push(d); return { externalId: "5" }; }) as never;
  const h = createIssueHandler({ reader: s.reader, connectors: { get: () => s.connector as any, keys: () => [] }, redactor: { redact: (x) => x.replace("b", "[redacted]") } });
  const m = { namespace: NS, source: s.store.get("Source/gh"), payload: { namespace: NS, proposal: "p", proposalUid: "u1", contentHash: approved.contentHash } };
  assert.deepEqual(await h.deliver(m), { externalId: "5" });
  assert.equal(drafts[0].marker, issueMarker("u1"));
  assert.equal(drafts[0].body, "[redacted]");
  await assert.rejects(h.recover(m), /outcome is unknown/);
  assert.equal(drafts.length, 1);
  s.connector.findCreatedIssues = async () => [{ externalId: "8" }] as never;
  assert.equal((await h.recover(m)).externalId, "8");
  await assert.rejects(h.deliver({ ...m, payload: { ...m.payload, contentHash: "bad" } }), /changed since approval/);
});

test("a rejected proposal can be edited and approved again", async () => {
  const s = setup();
  const approve = s.p().spec.review;
  s.p().spec.review = { decision: "reject", at: "2026-01-01T00:00:00Z", by: "h" } as any;
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Rejected");
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Rejected");
  s.p().spec.review = undefined;
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Proposed");
  s.p().spec.review = approve;
  await s.c.reconcile("default/p");
  assert.equal(s.p().status?.phase, "Creating");
});
