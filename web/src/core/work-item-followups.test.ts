import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS as p, type NewFollowUpInput } from "./ports/index.ts";
import type { AgentRun, Artifact, WorkItem } from "./model/kinds.ts";
import { LABEL_SUPERSEDED } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { ownerRef } from "./model/meta.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { DefaultWorkItemRecordReader } from "./agents/work-item-record.ts";
import { SecretRedactor } from "./transcripts/recorder.ts";
import { followUpPreview } from "./app/work-item-followups.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
test("factory shutdown waits for a newly started background agent before closing its database", { timeout: 5000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  let requested!: () => void;
  const request = new Promise<void>((r) => { requested = r; });
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-shutdown-fixture" },
    fetch: async () => { requested(); await hold; return Response.json({ choices: [{ message: { content: '{"summary":"done","artifacts":[],"questions":[]}' } }] }); } });
  let stopping: Promise<void> | undefined;
  try {
    await f.start();
    await f.app.createWorkItem(p, { title: "Shutdown immediately", description: "A new item starts its own background agent." });
    await request;
    let closed = false;
    stopping = f.stop().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, false, "database must remain open until the model call and status writes finish");
    release();
    await stopping;
    assert.equal(closed, true);
  } finally { release(); await (stopping ?? f.stop()); }
});

async function awaiting(f: Factory, name: string) {
  for (let i = 0; i < 800; i++) {
    const d = await f.app.getWorkItem(p, name);
    if (d?.workItem.status?.phase === "AwaitingApproval") return d;
    if (d?.workItem.status?.phase === "Failed") throw new Error(d.workItem.status.message);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("workflow did not reach its human gate");
}

test("follow-up: synced origin stays unchanged; selected workflow gets separate instructions and historical evidence", async () => {
  const env: Record<string, string | undefined> = {};
  const prompts: string[] = [];
  const writes: string[] = [];
  const mock: typeof fetch = async (url, init) => {
    const u = new URL(url instanceof Request ? url.url : String(url));
    if (u.pathname.startsWith("/rest/")) {
      if ((init?.method ?? "GET") !== "GET") writes.push(u.pathname);
      return Response.json(u.pathname.endsWith("/search")
        ? { issues: [{ key: "FOLLOW-1", fields: { summary: "Additional publisher credentials", description: "Publishing additional client events fails in the production environment after a deployment.", labels: [] } }] }
        : { comments: [] });
    }
    if (u.pathname === "/api/mcp") return new Response("fixture unavailable", { status: 503 });
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content?: string }[] };
    prompts.push(body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env, fetch: mock });
  await f.start();
  try {
    await f.app.syncSource(p, "jira-servicedesk");
    const name = "jira-servicedesk-follow-1";
    await awaiting(f, name);
    await f.manager.settle();
    const before = (await f.app.getWorkItem(p, name))!;
    const instructions = "Implement a new feature XYZ to support additional publisher credentials; preserve existing clients.";
    const preview = await f.app.previewWorkItemFollowUp(p, name, instructions);
    assert.deepEqual(await f.app.getWorkItem(p, name), before, "preview has no writes");
    assert.match(preview.snapshot.content, /support-analysis/);
    assert.match(preview.snapshot.content, /not approved for the new workflow/);
    const input: NewFollowUpInput = { requestId: "feature-xyz", expectedRevision: preview.revision, title: "Feature XYZ", description: "Implement additional publisher credential support.", context: instructions, workflowRef: "factory-loop", repositoryRefs: ["software-factory"] };
    env.OPENAI_API_KEY = "sk-followup-fixture";
    const [item, duplicate] = await Promise.all([f.app.createWorkItemFollowUp(p, name, input), f.app.createWorkItemFollowUp(p, name, input)]);
    assert.equal(item.metadata.name, duplicate.metadata.name);
    assert.equal(item.spec.sourceRef.name, "manual");
    assert.equal(item.spec.externalRef, undefined);
    assert.equal(item.spec.workflowRef?.name, "factory-loop");
    assert.deepEqual(item.spec.repositoryRefs, [{ name: "software-factory" }]);
    assert.equal(item.spec.context, instructions);
    assert.equal(item.spec.originWorkItemRef?.name, name);
    assert.equal(item.spec.originSnapshot?.uid, before.workItem.metadata.uid);
    assert.equal(item.metadata.ownerReferences?.length ?? 0, 0);
    assert.deepEqual(await f.app.getWorkItem(p, name), before, "creation never touches the original item, runs, gate or timeline");
    const done = await awaiting(f, item.metadata.name);
    assert.equal(done.workItem.status?.stage, "spec-review");
    assert.ok(done.approvals.length > 0 && done.approvals.every((a) => !a.spec.decision), "new workflow has its own pending gate");
    const ownPrompts = prompts.filter((u) => u.includes(`# Work item ${item.metadata.name}:`));
    assert.ok(ownPrompts.length >= 3);
    assert.ok(ownPrompts.every((u) => u.includes(instructions) && u.includes("## Inherited work-item evidence") && u.includes("Additional publisher credentials")));
    assert.deepEqual((await f.app.workItemFollowUps(p, name)).items.map((w) => w.metadata.name), [item.metadata.name]);
    assert.equal((await f.app.workItemFollowUps(p, item.metadata.name)).origin?.available, true);
    assert.deepEqual(writes, [], "follow-up never writes to the original Jira ticket");
    assert.ok(!f.exposedTools.some((t) => /followup/.test(t.name)), "follow-up creation is not exposed to agents");
  } finally { await f.stop(); }
});

test("follow-up: stale previews conflict; retries survive origin deletion and do not overwrite edits or attach to a recreated origin", async () => {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {} });
  try {
    const source = await f.app.createWorkItem(p, { title: "Original", description: "An original request" });
    const name = source.metadata.name;
    const preview = await f.app.previewWorkItemFollowUp(p, name, "Implement XYZ");
    const base: NewFollowUpInput = { requestId: "independent", expectedRevision: preview.revision, title: "Independent feature", context: "Implement XYZ", workflowRef: "factory-loop", repositoryRefs: ["software-factory"] };
    await f.app.updateWorkItemContext(p, name, "New source evidence");
    await assert.rejects(f.app.createWorkItemFollowUp(p, name, base), /Refresh the context preview/);
    const fresh = await f.app.previewWorkItemFollowUp(p, name, base.context);
    const input = { ...base, expectedRevision: fresh.revision };
    await assert.rejects(f.app.createWorkItemFollowUp(p, name, { ...input, workflowRef: "construction-bolt" }), /can't be used/);
    await assert.rejects(f.app.createWorkItemFollowUp(p, name, { ...input, repositoryRefs: [] }), /select at least one repository/);
    const item = await f.app.createWorkItemFollowUp(p, name, input);
    const another = await f.app.createWorkItemFollowUp(p, name, { ...input, requestId: "another" });
    assert.notEqual(item.metadata.name, another.metadata.name);
    await assert.rejects(f.app.createWorkItemFollowUp(p, name, { ...input, title: "Changed input" }), /different follow-up input/);
    await f.app.deleteWorkItem(p, name);
    const edited = await f.app.updateWorkItemContext(p, item.metadata.name, "Human edit after origin deletion");
    const retry = await f.app.createWorkItemFollowUp(p, name, input);
    assert.equal(retry.spec.context, edited.spec.context);
    assert.deepEqual(retry.spec.originSnapshot, item.spec.originSnapshot, "snapshot remains immutable");
    assert.equal((await f.app.workItemFollowUps(p, item.metadata.name)).origin?.available, false);
    await assert.rejects(f.app.previewWorkItemFollowUp(p, name), /not found/);
    const replacement = await f.app.createWorkItem(p, { title: "Original" });
    assert.equal(replacement.metadata.name, name);
    assert.notEqual(replacement.metadata.uid, source.metadata.uid);
    assert.equal((await f.app.workItemFollowUps(p, name)).items.length, 0);
    assert.equal((await f.app.workItemFollowUps(p, item.metadata.name)).origin?.available, false);
    assert.equal((await f.app.listWorkItems(p)).length, 3);
  } finally { await f.stop(); }
});

test("follow-up snapshot: namespace scoped, excludes stale/replay evidence, redacts and truncates evidence before instructions", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteStore(db, { now: () => new Date() });
  const reader = new DefaultWorkItemRecordReader(store);
  const redactor = new SecretRedactor();
  const secret = "sk-followup-sensitive-fixture";
  redactor.add(secret);
  try {
    const wi = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "origin", namespace: "default" }, spec: { title: "Evidence", sourceRef: { name: "manual" }, context: `Team note ${secret}`, originWorkItemRef: { name: "ancestor" }, originSnapshot: { uid: "ancestor", resourceVersion: "1", capturedAt: "2026-01-01T00:00:00.000Z", versions: {}, content: "Ancestor snapshot must not expand", truncated: false } } });
    const metadata = { namespace: "default", ownerReferences: [ownerRef(wi)] };
    const spec = { workItemRef: { name: wi.metadata.name }, workflowRef: { name: "servicedesk" }, agentRef: { name: "support-engineer" }, skillRefs: [], stage: "investigate", step: "0", inputs: [], outputs: [] };
    await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata: { ...metadata, name: "stale", labels: { [LABEL_SUPERSEDED]: "true" } }, spec });
    await store.create<AgentRun>({ apiVersion: API_VERSION, kind: "AgentRun", metadata: { ...metadata, name: "replay" }, spec: { ...spec, replayOf: { name: "stale" } } });
    for (const [name, run, content, namespace] of [
      ["late", "stale", "Superseded output arriving late", "default"],
      ["replayed", "replay", "Replay output", "default"],
      ["private", "current", "Other namespace output", "other"],
      ["current", "current", `Current finding ${secret} ${"Evidence ".repeat(6000)}`, "default"],
    ]) await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { ...metadata, name, namespace }, spec: { workItemRef: { name: wi.metadata.name }, artifactTypeRef: { name: "research-notes" }, format: "markdown", content, producedBy: { agentRunRef: { name: run }, agentRef: { name: "support-engineer" } } } });
    const instructions = `Implement feature XYZ. ${"x".repeat(15000)} ${secret}`;
    const record = await reader.read("default", wi.metadata.name);
    const preview = followUpPreview(record, instructions, redactor, "2026-11-13T10:00:00.000Z", 20000);
    assert.equal(preview.instructions, redactor.redact(instructions), "new instructions are preserved in full");
    assert.ok(preview.snapshot.content.length + preview.instructions.length <= 20000);
    assert.equal(preview.snapshot.truncated, true);
    assert.match(preview.snapshot.content, /\[Inherited evidence truncated\]$/);
    assert.match(preview.snapshot.content, /Current finding/);
    assert.doesNotMatch(preview.snapshot.content, /Superseded output|Replay output|Other namespace output|Ancestor snapshot/);
    assert.ok(!JSON.stringify(preview).includes(secret));
    assert.ok(!Object.keys(preview.snapshot.versions).some((k) => /stale|replay|late|private/.test(k)));
    assert.equal(followUpPreview(record, instructions, redactor, "2026-11-13T11:00:00.000Z", 20000).revision, preview.revision);
    assert.notEqual(followUpPreview(record, "Different objective", redactor, preview.snapshot.capturedAt, 20000).revision, preview.revision);
    assert.throws(() => followUpPreview(record, "x".repeat(20000), redactor, preview.snapshot.capturedAt, 20000), /too long/);
    await assert.rejects(reader.read("factory-system", wi.metadata.name), /not found/);
  } finally { db.close(); }
});
