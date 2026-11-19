import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS as p } from "./ports/index.ts";
import { issueContentHash } from "./issues/admission.ts";
import { renderFollowUpTicketBody } from "./issues/followup-body.ts";
import { createIssueProposalController } from "./issues/controller.ts";
import { createIssueLinkHandler } from "./issues/handler.ts";
import type { IssueProposal } from "./model/kinds.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

test("AC-1/AC-2: a click creates one Approved, revision-bound follow-up proposal; stale and servicedesk are rejected", async () => {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_SIMULATION: "wait" }, fetch: async () => new Response("no", { status: 503 }) });
  try {
    const item = await f.app.createWorkItem(p, { title: "Spec key order", description: "Keys are reordered on the Playground." });
    const name = item.metadata.name;
    const preview = await f.app.previewWorkItemFollowUp(p, name, "");
    const input = { requestId: "r1", expectedRevision: preview.revision, title: "Keep key order", targetSource: "jira-main", labels: ["hyperion"] };
    const proposal = await f.app.createFollowUpTicket(p, name, input);
    assert.equal(proposal.metadata.name, `${name}-followup-r1`);
    assert.equal(proposal.spec.purpose, "follow-up");
    assert.equal(proposal.spec.revision, preview.revision);
    assert.equal(proposal.spec.review?.decision, "approve");
    assert.equal(proposal.spec.review?.contentHash, issueContentHash(proposal.spec));
    assert.equal(proposal.metadata.ownerReferences?.[0].name, name);
    assert.match(proposal.spec.body, /Keys are reordered/);
    assert.match(proposal.spec.body, new RegExp(`Factory work item: ${name}`));

    const again = await f.app.createFollowUpTicket(p, name, input);
    assert.equal(again.metadata.uid, proposal.metadata.uid);
    assert.equal((await f.app.listIssueProposals(p)).length, 1);

    await assert.rejects(f.app.createFollowUpTicket(p, name, { ...input, requestId: "r2", expectedRevision: "stale" }), /changed|Refresh/);
    await assert.rejects(f.app.createFollowUpTicket(p, name, { ...input, requestId: "r3", targetSource: "jira-servicedesk" }), /does not permit creating issues/);
    assert.equal((await f.app.listIssueProposals(p)).length, 1);
  } finally { await f.stop(); }
});

test("body renderer includes origin URL, factory link and evidence", () => {
  const body = renderFollowUpTicketBody({ instructions: "Do X", originName: "w1", originUrl: "https://j/browse/SD-1", factoryUrl: "https://f/", snapshot: { uid: "u", resourceVersion: "1", capturedAt: "t", versions: {}, content: "EVIDENCE", truncated: false } });
  assert.match(body, /Do X/); assert.match(body, /https:\/\/j\/browse\/SD-1/); assert.match(body, /https:\/\/f\/work-items\/w1/); assert.match(body, /EVIDENCE/);
});

function linkSetup(opts: { linkOrigin: boolean; originBase: string; fail?: boolean }) {
  const store = new Map<string, any>();
  const k = (kind: string, name: string) => `${kind}/${name}`;
  const put = (o: any) => store.set(k(o.kind, o.metadata.name), o);
  const src = (name: string, base: string, issues?: any) => put({ kind: "Source", metadata: { name, namespace: "default" }, spec: { type: "jira", connection: { baseUrl: base }, ...(issues ? { writeBack: { issues } } : {}) } });
  src("jira-main", "https://j.example", { project: "P", linkOrigin: opts.linkOrigin });
  src("origin-src", opts.originBase);
  put({ kind: "WorkItem", metadata: { name: "w1", namespace: "default", uid: "wu" }, spec: { title: "t", sourceRef: { name: "origin-src" }, externalRef: { id: "SD-1" } } });
  const spec: IssueProposal["spec"] = { purpose: "follow-up", title: "t", body: "b", targetRef: { name: "jira-main" }, revision: "r", provenance: { workItem: "w1", human: true } };
  put({ kind: "IssueProposal", metadata: { name: "p", namespace: "default", uid: "u1" }, spec: { ...spec, review: { decision: "approve", contentHash: issueContentHash(spec) } }, status: { phase: "Created", externalRef: { externalId: "P-9" } } });
  const links: any[] = [];
  const connector = { type: "jira", linkIssues: async (_s: any, from: string, to: string) => { if (opts.fail) throw new Error("boom"); links.push([from, to]); } };
  const reader: any = { get: async (kind: string, _n: string, name: string) => store.get(k(kind, name)) ?? null, list: async (kind: string) => [...store.values()].filter((o) => o.kind === kind) };
  const enqueued: any[] = [];
  const c = createIssueProposalController({
    reader, clock: { now: () => new Date() }, status: { updateStatus: async (o: any) => { put(o); return o; } } as any,
    events: { normal: async () => {}, warning: async () => {} },
    outbox: { enqueue: async (m: any) => { enqueued.push(m); if (!store.has(k("OutboxMessage", m.key))) put({ kind: "OutboxMessage", metadata: { name: m.key, namespace: "default" }, spec: m, status: { phase: "Pending", attempts: 0 } }); } },
    connectors: { get: () => connector as any, keys: () => ["jira"] },
  });
  const handler = createIssueLinkHandler({ reader, connectors: { get: () => connector as any, keys: () => ["jira"] } });
  return { c, store, enqueued, links, handler, p: () => store.get("IssueProposal/p") as IssueProposal };
}

test("AC-7: linkOrigin off by default adds no link; on, one relates-to link is enqueued once and delivered", async () => {
  const off = linkSetup({ linkOrigin: false, originBase: "https://j.example" });
  await off.c.reconcile("default/p");
  assert.equal(off.enqueued.length, 0);
  assert.equal(off.p().status?.conditions?.[0].reason, "NotRequested");

  const on = linkSetup({ linkOrigin: true, originBase: "https://j.example/" });
  assert.deepEqual(await on.c.reconcile("default/p"), { requeueAfterMs: 2000 });
  await on.c.reconcile("default/p");
  assert.equal(on.enqueued.length, 2);
  assert.equal(new Set(on.enqueued.map((m) => m.key)).size, 1);
  assert.equal(on.enqueued[0].payload.to, "SD-1");
  await on.handler.deliver({ namespace: "default", source: on.store.get("Source/jira-main"), payload: on.enqueued[0].payload });
  assert.deepEqual(on.links, [["P-9", "SD-1"]]);
  on.store.get("OutboxMessage/p-link").status = { phase: "Delivered", attempts: 1 };
  await on.c.reconcile("default/p");
  assert.equal(on.p().status?.phase, "Created");
  assert.equal(on.p().status?.conditions?.find((x) => x.type === "Linked")?.status, "True");
});

test("AC-7: another instance is not linked; a failed link leaves the ticket Created and records the failure", async () => {
  const other = linkSetup({ linkOrigin: true, originBase: "https://other.example" });
  await other.c.reconcile("default/p");
  assert.equal(other.enqueued.length, 0);
  assert.equal(other.p().status?.conditions?.[0].reason, "NoSameInstanceOrigin");

  const bad = linkSetup({ linkOrigin: true, originBase: "https://j.example", fail: true });
  await bad.c.reconcile("default/p");
  await assert.rejects(bad.handler.deliver({ namespace: "default", source: bad.store.get("Source/jira-main"), payload: bad.enqueued[0].payload }), /boom/);
  bad.store.get("OutboxMessage/p-link").status = { phase: "Failed", attempts: 5, lastError: "boom" };
  await bad.c.reconcile("default/p");
  assert.equal(bad.p().status?.phase, "Created");
  assert.equal(bad.p().status?.conditions?.find((x) => x.type === "Linked")?.reason, "LinkFailed");
});
