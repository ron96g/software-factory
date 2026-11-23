import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS as p } from "./ports/index.ts";
import { issueContentHash } from "./issues/admission.ts";
import { renderFollowUpTicketBody } from "./issues/followup-body.ts";
import { ProductOwnerTicketDrafter } from "./issues/ticket-drafter.ts";
import { createIssueProposalController } from "./issues/controller.ts";
import { createIssueLinkHandler } from "./issues/handler.ts";
import type { Conversation, IssueProposal } from "./model/kinds.ts";

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
    assert.doesNotMatch(proposal.spec.body, /Origin work item:|## Agent findings/, "ADR-0076: no evidence dump without a reviewed body");

    const again = await f.app.createFollowUpTicket(p, name, input);
    assert.equal(again.metadata.uid, proposal.metadata.uid);
    assert.equal((await f.app.listIssueProposals(p)).length, 1);

    await assert.rejects(f.app.createFollowUpTicket(p, name, { ...input, requestId: "r2", expectedRevision: "stale" }), /changed|Refresh/);
    await assert.rejects(f.app.createFollowUpTicket(p, name, { ...input, requestId: "r3", targetSource: "jira-servicedesk" }), /does not permit creating issues/);
    assert.equal((await f.app.listIssueProposals(p)).length, 1);
  } finally { await f.stop(); }
});

test("body renderer puts the reviewed body first and always appends origin URL and the item page link", () => {
  const body = renderFollowUpTicketBody({ body: "## Problem\nDo X", originName: "w1", originUrl: "https://j/browse/SD-1", factoryUrl: "https://f/" });
  assert.ok(body.startsWith("## Problem\nDo X"));
  assert.match(body, /## Origin[\s\S]*https:\/\/j\/browse\/SD-1[\s\S]*https:\/\/f\/items\/w1/);
});

test("ADR-0076: without an LLM, drafting returns the template in one recorded draft-ticket conversation; Create uses the reviewed body", async () => {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_SIMULATION: "wait" }, fetch: async () => new Response("no", { status: 503 }), log: () => {} });
  try {
    await f.start(); // the conversation controller opens the drafting transcript
    const item = await f.app.createWorkItem(p, { title: "Spec key order", description: "Keys are reordered on the Playground." });
    const name = item.metadata.name;
    const instructions = "We MUST keep the author's key order";
    // The controllers keep working on the item, so a reviewed revision can go stale; like the dialog, refresh and retry.
    const fresh = async <T>(call: (expectedRevision: string) => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        const { revision } = await f.app.previewWorkItemFollowUp(p, name, instructions);
        try { return await call(revision); } catch (e) {
          if (i >= 20 || !/Refresh/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
    const base = { instructions, targetSource: "jira-main", title: "Keep key order" };
    const first = await fresh((expectedRevision) => f.app.draftFollowUpTicket(p, name, { ...base, expectedRevision }));
    assert.equal(first.draftedBy, "template");
    assert.match(first.reason ?? "", /No LLM/);
    assert.match(first.body, /## Requirements[\s\S]*MUST keep[\s\S]*## Background[\s\S]*Keys are reordered/);
    assert.doesNotMatch(first.body, /Origin work item:/);
    const conv = await f.app.getResource(p, "conversations", first.conversation) as Conversation | null;
    assert.equal(conv?.spec.purpose, "draft-ticket");
    assert.equal(conv?.spec.agentRef?.name, "product-owner");
    assert.equal(conv?.metadata.ownerReferences?.[0].name, name);

    const edited = `${first.body}\n\n## Acceptance criteria\n1. **Given** a spec, **when** it is downloaded, **then** the key order is unchanged.`;
    const again = await fresh((expectedRevision) => f.app.draftFollowUpTicket(p, name, { ...base, expectedRevision, conversation: first.conversation, previous: { title: "Keep spec key order", body: edited }, feedback: "shorter" }));
    assert.equal(again.conversation, first.conversation);
    assert.equal(again.body, edited, "without an LLM a redraft keeps the human's edits");
    const transcript = await f.app.conversationMessages(p, first.conversation);
    assert.equal(transcript.filter((m) => m.role === "user").length, 2);
    assert.match(transcript[0].content, /Evidence from the investigation[\s\S]*Keys are reordered/);

    await assert.rejects(f.app.draftFollowUpTicket(p, name, { ...base, expectedRevision: "stale" }), /Refresh/);
    await assert.rejects(fresh((expectedRevision) => f.app.draftFollowUpTicket(p, name, { ...base, expectedRevision, conversation: "nope" })), /does not belong/);
    await assert.rejects(f.app.draftFollowUpTicket(p, name, { ...base, expectedRevision: "any", targetSource: "jira-servicedesk" }), /does not permit creating issues/);

    const create = { requestId: "d1", title: again.title, instructions, body: edited, draftConversation: first.conversation, targetSource: "jira-main" };
    const proposal = await fresh((expectedRevision) => f.app.createFollowUpTicket(p, name, { ...create, expectedRevision }));
    assert.ok(proposal.spec.body.startsWith(edited));
    assert.match(proposal.spec.body, new RegExp(`## Origin[\\s\\S]*Factory work item: ${name}`));
    assert.equal(proposal.spec.provenance?.draftedBy, undefined, "a template-only conversation is not agent provenance");
    assert.equal(proposal.spec.review?.contentHash, issueContentHash(proposal.spec));
    await assert.rejects(f.app.createFollowUpTicket(p, name, { ...create, expectedRevision: proposal.spec.revision!, body: "other" }), /different follow-up input/);
  } finally { await f.stop(); }
});

function drafterSetup(answer: string) {
  const messages: any[] = [];
  const calls: any[] = [];
  const defs: Record<string, any> = {
    "Agent/product-owner": { kind: "Agent", metadata: { name: "product-owner", namespace: "factory-system" }, spec: { model: { tier: "reasoning" } }, body: "PO PERSONA" },
    "Skill/ticket-writing": { kind: "Skill", metadata: { name: "ticket-writing", namespace: "factory-system" }, spec: {}, body: "SMART RULES" },
  };
  const drafter = new ProductOwnerTicketDrafter({
    reader: { get: async (kind: string, _ns: string, name: string) => defs[`${kind}/${name}`] ?? null, list: async () => [] } as any,
    transcripts: { read: async () => messages } as any,
    recorders: { forConversation: async () => ({ ref: { namespace: "default", id: "t" }, record: async (m: any) => { messages.push(m); } }) } as any,
    models: { resolve: async (q: any) => (q.agent === "product-owner" ? { model: "m1", tier: "reasoning", client: { complete: async (req: any) => { calls.push(req); return answer; } } } : undefined) } as any,
    redactor: { redact: (t: string) => t.replaceAll("sk-secret", "[REDACTED]") },
    agent: "product-owner", skill: "ticket-writing",
  });
  const conv = { kind: "Conversation", metadata: { name: "c1", namespace: "default" }, spec: { purpose: "draft-ticket" }, status: { transcriptRef: { namespace: "default", id: "t" } } } as unknown as Conversation;
  const req = { namespace: "default", originTitle: "Spec order", instructions: "We MUST keep order", evidence: "rover-server/apispecification.go:162 token sk-secret", target: { source: "jira-main", type: "jira", project: "DHEI" } };
  return { drafter, conv, req, messages, calls };
}

test("ADR-0076: the product owner drafts with persona + skill; the call is recorded, redacted and parsed from the fence", async () => {
  const { drafter, conv, req, messages, calls } = drafterSetup("Here you go.\n````ticket-draft\n# Keep spec key order sk-secret\n## Problem\nKeys are sorted.\n```yaml\nopenapi: 3\n```\n````");
  const draft = await drafter.draft(conv, req, { type: "human", id: "u" });
  assert.deepEqual({ title: draft.title, draftedBy: draft.draftedBy, agent: draft.agent, model: draft.model }, { title: "Keep spec key order [REDACTED]", draftedBy: "agent", agent: "product-owner", model: "m1" });
  assert.equal(draft.body, "## Problem\nKeys are sorted.\n```yaml\nopenapi: 3\n```");
  const [system, user] = calls[0].messages;
  assert.match(system.content, /PO PERSONA[\s\S]*SMART RULES[\s\S]*ticket-draft/);
  assert.match(user.content, /project DHEI[\s\S]*We MUST keep order[\s\S]*apispecification\.go:162/);
  assert.doesNotMatch(user.content, /sk-secret/);
  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.equal(messages[2].meta.model, "m1");

  await drafter.draft(conv, { ...req, previous: { title: "T", body: "OLD BODY" }, feedback: "add a JSON criterion" }, { type: "human", id: "u" });
  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "user", "assistant"], "the system prompt is recorded once per conversation");
  assert.match(calls[1].messages[1].content, /Current draft[\s\S]*OLD BODY[\s\S]*add a JSON criterion[\s\S]*Revise/);
});

test("ADR-0076: an answer without a draft block is shown unchanged with a reason", async () => {
  const { drafter, conv, req } = drafterSetup("## Problem\nNo fence here.");
  const draft = await drafter.draft(conv, { ...req, title: "Working title" }, { type: "human", id: "u" });
  assert.equal(draft.title, "Working title");
  assert.equal(draft.body, "## Problem\nNo fence here.");
  assert.match(draft.reason ?? "", /no draft block/);
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
