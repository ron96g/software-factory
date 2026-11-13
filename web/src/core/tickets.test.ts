import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS as p } from "./ports/index.ts";
import type { Approval, Artifact, OutboxMessage, Source, WorkItem } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { ownerRef } from "./model/meta.ts";
import { JiraConnector } from "./adapters/sources/jira.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { Registry } from "./registry/registry.ts";
import type { OutboxHandler, SourceConnector, SourceWritePolicy } from "./ports/index.ts";
import { SecretRedactor } from "./transcripts/recorder.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { createOutboxController } from "./runtime/outbox.ts";
import { ticketHandlers, ticketPublicationGate } from "./tickets/publication.ts";
import { fingerprint } from "./app/work-item-followups.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const key = "jira-servicedesk-desk-1";
const statuses = { pending: { id: "1", name: "Pending" }, progress: { id: "2", name: "In Progress" }, waiting: { id: "3", name: "Waiting for Customer" } };
function fakeJira() {
  let state = statuses.pending;
  const comments: { id: string; body: string; public: boolean }[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let rejectTransition = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), path = url.pathname;
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/rest/servicedeskapi/request/DESK-1/comment") {
        if (typeof body.public !== "boolean") throw new Error("explicit public flag required");
        const c = { id: String(comments.length + 1), body: String(body.body), public: body.public }; comments.push(c);
        return Response.json(c, { status: 201 });
      }
      if (path === "/rest/api/2/issue/DESK-1/transitions") {
        if (rejectTransition) return new Response("Transition rejected by Jira", { status: 400 });
        const t = body.transition as { id: string };
        state = t.id === "31" ? statuses.progress : statuses.waiting;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected Jira write: ${path}`);
    }
    if (path === "/rest/api/2/search") return Response.json({ issues: [{ key: "DESK-1", fields: { summary: "Additional publisher credentials fail", description: "Credentials are missing for additional publishers in the production cluster after the latest deployment.", labels: ["factory"] } }] });
    if (path === "/rest/api/2/issue/DESK-1/comment") return Response.json({ comments: [] });
    if (path === "/rest/servicedeskapi/request/DESK-1/comment") return Response.json({ values: comments, isLastPage: true });
    if (path === "/rest/api/2/issue/DESK-1/transitions") return Response.json({ transitions: [
      ...(state.id === "1" ? [{ id: "31", name: "Start progress", to: statuses.progress }] : []),
      ...(state.id === "2" ? [{ id: "41", name: "Wait for customer", to: statuses.waiting }] : []),
      { id: "99", name: "Resolve with required fields", to: { id: "4", name: "Resolved" }, fields: { resolution: { required: true } } },
    ] });
    if (path === "/rest/api/2/issue/DESK-1") return Response.json({ fields: { status: state } });
    throw new Error(`unexpected request: ${path}`);
  };
  return { fetch, writes, comments, rejectTransition: () => { rejectTransition = true; }, setState: (id: "pending" | "progress" | "waiting") => { state = statuses[id]; } };
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 1000; i++) { const result = await read(); if (result !== undefined) return result; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out: ${label}`);
}
async function publicationReview(f: Factory) {
  await f.app.syncSource(p, "jira-servicedesk");
  const response = await until(async () => { const d = await f.app.getWorkItem(p, key); return d?.workItem.status?.stage === "response-review" && d.workItem.status.phase === "AwaitingApproval" ? d : undefined; }, "response review");
  await f.app.decideApproval(p, response.workItem.status!.blockedBy!.name, "approve");
  return until(async () => { const d = await f.app.getWorkItem(p, key); return d?.workItem.status?.stage === "publish-response" && d.workItem.status.phase === "AwaitingApproval" ? d : undefined; }, "new publication review");
}

test("reviewed Jira publication: no implicit writes, live Pending → In Progress → Waiting for Customer, one public reply", async () => {
  const jira = fakeJira(), f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, fetch: jira.fetch });
  await f.start();
  try {
    const detail = await publicationReview(f);
    assert.equal(jira.writes.length, 0, "response-review approval alone cannot publish");
    await assert.rejects(f.app.decideApproval(p, detail.workItem.status!.blockedBy!.name, "approve"), /publication review/);
    let review = await f.tickets.review(p, key);
    assert.equal(review.ticket?.state.name, "Pending");
    assert.equal(review.ticket?.state.transitions.find((t) => t.id === "99")?.requiresFields, true);
    await assert.rejects(f.tickets.requestTransition(p, key, { requestId: "requires-form", revision: review.revision!, transitionId: "99" }), /Jira form/);
    await assert.rejects(f.tickets.approvePublication(p, key, { revision: "stale", visibility: "public" }), /refresh/);
    const input = { requestId: "start-progress", revision: review.revision!, transitionId: "31" };
    const status = await f.tickets.requestTransition(p, key, input);
    await until(async () => (await f.tickets.review(p, key)).deliveries.find((m) => m.metadata.name === status.metadata.name && m.status?.phase === "Delivered"), "standalone transition");
    assert.equal((await f.tickets.requestTransition(p, key, input)).metadata.uid, status.metadata.uid, "lost response retry returns the original request after Jira changed");
    await assert.rejects(f.tickets.requestTransition(p, key, { ...input, transitionId: "41" }), /different transition input/);
    assert.equal(jira.comments.length, 0, "status-only action cannot post a comment");
    review = await f.tickets.review(p, key);
    assert.equal(review.ticket?.state.name, "In Progress");
    const draft = review.approval!.spec.ticketPublication!.body;
    const decision = { revision: review.revision!, visibility: "public" as const, transitionId: "41" };
    await f.tickets.approvePublication(p, key, decision);
    await until(async () => { const d = await f.app.getWorkItem(p, key); if (d?.workItem.status?.phase === "Failed") throw new Error(d.workItem.status.message); return d?.workItem.status?.phase === "Done" ? d : undefined; }, "delivery before Done");
    assert.equal(jira.comments.length, 1);
    assert.equal(jira.comments[0].public, true);
    assert.ok(jira.comments[0].body.startsWith(`${draft}\n\n[software-factory:ticket-reply-`));
    assert.deepEqual(jira.writes.map((w) => w.path), ["/rest/api/2/issue/DESK-1/transitions", "/rest/servicedeskapi/request/DESK-1/comment", "/rest/api/2/issue/DESK-1/transitions"]);
    assert.equal((await f.tickets.review(p, key)).ticket?.state.name, "Waiting for Customer");
    assert.ok(!f.exposedTools.some((t) => /publish|transition/.test(t.name)), "Jira mutation commands are not agent tools");
  } finally { await f.stop(); }
});

test("internal Jira reply with a failed follow-on transition retains the reply receipt and never blindly retries", async () => {
  const jira = fakeJira(); jira.setState("progress"); jira.rejectTransition();
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, fetch: jira.fetch });
  await f.start();
  try {
    await publicationReview(f);
    const review = await f.tickets.review(p, key);
    await f.tickets.approvePublication(p, key, { revision: review.revision!, visibility: "internal", transitionId: "41" });
    await until(async () => { const d = await f.app.getWorkItem(p, key); return d?.workItem.status?.phase === "Failed" ? d : undefined; }, "partial delivery surfaced");
    const result = await f.tickets.review(p, key);
    assert.equal(jira.comments.length, 1); assert.equal(jira.comments[0].public, false);
    assert.equal(result.deliveries.find((m) => m.spec.action === "service-desk-reply")?.status?.phase, "Delivered");
    assert.match(result.deliveries.find((m) => m.spec.action === "ticket-transition")?.status?.lastError ?? "", /No automatic POST retry/);
    assert.equal(jira.writes.filter((w) => w.path.endsWith("/transitions")).length, 1);
  } finally { await f.stop(); }
});

test("legacy completed service-desk items require a fresh publication review and reuse their existing response", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "factory-ticket-review-")), path = resolve(dir, "factory.sqlite");
  const db = new DatabaseSync(path), store = new SqliteStore(db, { now: () => new Date() }), jira = fakeJira();
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: key, namespace: "default" },
    spec: { title: "Previously reviewed service request", sourceRef: { name: "jira-servicedesk" }, workflowRef: { name: "servicedesk" }, externalRef: { id: "DESK-1" } },
    status: { phase: "Done", stage: "response-review", round: 8 } });
  await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "old-response", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: key }, artifactTypeRef: { name: "customer-response" }, format: "markdown", content: "Existing reviewed answer; no new model run needed." } });
  await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval", metadata: { name: `${key}-response-review-r8`, namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { workItemRef: { name: key }, stage: "response-review", approvers: [], decision: "approve", decidedBy: p.id }, status: { phase: "Approved" } });
  db.close();
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: path, env: {}, fetch: jira.fetch });
  await f.start();
  try {
    assert.equal((await f.tickets.review(p, key)).canStartPublication, true);
    assert.equal((await f.app.getWorkItem(p, key))?.workItem.status?.phase, "Done");
    assert.equal(jira.writes.length, 0, "deployment never republishes a historical approval");
    await f.tickets.beginPublication(p, key);
    await until(async () => { const r = await f.tickets.review(p, key); return r.approval ? r : undefined; }, "fresh legacy publication review");
    const review = await f.tickets.review(p, key);
    assert.equal((await f.app.getWorkItem(p, key))?.runs.length, 0, "investigation is not repeated");
    assert.equal(review.approval?.spec.ticketPublication?.body, "Existing reviewed answer; no new model run needed.");
    assert.equal(jira.writes.length, 0);
    await f.tickets.approvePublication(p, key, { revision: review.revision!, visibility: "internal" });
    await until(async () => (await f.app.getWorkItem(p, key))?.workItem.status?.phase === "Done" ? true : undefined, "legacy publication completes");
    assert.equal(jira.comments.length, 1); assert.equal(jira.comments[0].public, false);
  } finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("ticket delivery recovery observes receipts without reposting; changed evidence and cross-namespace messages cannot publish", async () => {
  const db = new DatabaseSync(":memory:"), clock = { now: () => new Date() }, store = new SqliteStore(db, clock), redactor = new SecretRedactor(), jira = fakeJira();
  const source = await store.create<Source>({ apiVersion: API_VERSION, kind: "Source", metadata: { name: "desk", namespace: "factory-system" }, spec: { type: "jira", connection: { url: "https://jira.example", deployment: "datacenter" }, sync: { bidirectional: false }, writeBack: { replyVisibilities: ["internal"], transitions: true } } });
  const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "w", namespace: "default" }, spec: { title: "Response", sourceRef: { name: "desk" }, externalRef: { id: "DESK-1" } }, status: { phase: "AwaitingApproval", stage: "publish-response", round: 3, blockedBy: { kind: "Approval", name: "a" } } });
  const artifact = await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: "draft", namespace: "default", ownerReferences: [ownerRef(item)] }, spec: { workItemRef: { name: "w" }, artifactTypeRef: { name: "customer-response" }, format: "markdown", content: "Reviewed response." } });
  const approval = await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval", metadata: { name: "a", namespace: "default", ownerReferences: [ownerRef(item)] }, spec: {
    workItemRef: { name: "w" }, stage: "publish-response", approvers: [], decision: "approve", decidedBy: p.id,
    ticketPublication: { workItemUid: item.metadata.uid!, source: "desk", sourceVersion: source.metadata.resourceVersion!, externalId: "DESK-1", artifact: { name: "draft", uid: artifact.metadata.uid!, version: artifact.metadata.resourceVersion! }, body: artifact.spec.content,
      reviewed: { revision: "review", by: p.id, visibility: "internal", fromStatusId: "1" } },
  } });
  const connectors = new Registry<SourceConnector>(), handlers = new Registry<OutboxHandler>(), policies = new Registry<SourceWritePolicy>();
  const connector = new JiraConnector({ resolve: () => undefined }, jira.fetch);
  connectors.register("jira", connector);
  for (const h of ticketHandlers({ reader: store, connectors, redactor })) handlers.register(h.action, h);
  policies.register("service-desk-reply", { check: () => undefined });
  const controller = createOutboxController({ reader: store, status: store, events: new StoreEventRecorder(store), clock, redactor, handlers, policies });
  const payload = { namespace: "default", workItem: "w", workItemUid: item.metadata.uid, sourceVersion: source.metadata.resourceVersion, approval: "a", approvalUid: approval.metadata.uid, reviewHash: fingerprint(approval.spec.ticketPublication) };
  jira.comments.push({ id: "42", public: false, body: `${artifact.spec.content}\n\n[software-factory:ticket-reply-${approval.metadata.uid}]` });
  let message = await store.create<OutboxMessage>({ apiVersion: API_VERSION, kind: "OutboxMessage", metadata: { name: "interrupted", namespace: "default" }, spec: { sourceRef: { name: source.metadata.name }, externalId: "DESK-1", action: "service-desk-reply", payload }, status: { phase: "Delivering" } });
  try {
    await controller.reconcile("default/interrupted");
    message = (await store.get<OutboxMessage>("OutboxMessage", "default", "interrupted"))!;
    assert.equal(message.status?.phase, "Delivered"); assert.equal(message.status.result?.commentId, "42"); assert.deepEqual(jira.writes, []);
    jira.comments.length = 0;
    message = await store.updateStatus<OutboxMessage>({ ...message, status: { phase: "Delivering" } });
    await controller.reconcile("default/interrupted");
    assert.match((await store.get<OutboxMessage>("OutboxMessage", "default", "interrupted"))?.status?.lastError ?? "", /outcome is unknown/);
    await store.create<OutboxMessage>({ ...message, metadata: { name: "forged", namespace: "default" }, spec: { ...message.spec, payload: { ...payload, namespace: "factory-system" } }, status: { phase: "Pending" } });
    await controller.reconcile("default/forged");
    assert.match((await store.get<OutboxMessage>("OutboxMessage", "default", "forged"))?.status?.lastError ?? "", /cross namespaces/);
    await store.update<Artifact>({ ...artifact, spec: { ...artifact.spec, content: "Changed after approval" } });
    await store.create<OutboxMessage>({ ...message, metadata: { name: "changed", namespace: "default" }, status: { phase: "Pending" } });
    await controller.reconcile("default/changed");
    assert.match((await store.get<OutboxMessage>("OutboxMessage", "default", "changed"))?.status?.lastError ?? "", /response evidence changed/);
    const gate = ticketPublicationGate({ reader: store, redactor, outbox: { enqueue: async () => { assert.fail("stale approvals must not enqueue delivery"); } } });
    const spec = { type: "ticket-publication", publication: { artifactRef: { name: "customer-response" }, reviewStage: "response-review" } };
    const ctx = { workItem: item, stage: { name: "publish-response", lifecyclePhase: "operations", origin: "servicedesk", steps: [], gate: spec }, gate: spec };
    const stale = await gate.evaluateApproval(ctx, approval);
    assert.equal(stale.action, "fail", "stale evidence fails visibly rather than triggering an endless optimistic-conflict requeue");
    assert.equal((await gate.evaluate(ctx)).action, "fail", "publication cannot skip the preceding response review");
    await store.update<Source>({ ...source, spec: { ...source.spec, connection: { ...source.spec.connection, url: "https://different-jira.example" } } });
    await store.create<OutboxMessage>({ ...message, metadata: { name: "source-changed", namespace: "default" }, status: { phase: "Pending" } });
    await controller.reconcile("default/source-changed");
    assert.match((await store.get<OutboxMessage>("OutboxMessage", "default", "source-changed"))?.status?.lastError ?? "", /source configuration changed/);
    assert.deepEqual(jira.writes, []);
    await assert.rejects(connector.postComment(source, "DESK-1", "automatic question"), /read-only/);
    await assert.rejects(connector.publishReply(source, "DESK-1", "public mistake", "public"), /does not allow public/);
    assert.deepEqual(jira.writes, []);
  } finally { db.close(); }
});
