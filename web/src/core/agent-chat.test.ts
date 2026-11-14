import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS as p, StoreError, type ConversationTurnRunner } from "./ports/index.ts";
import type { Approval, Artifact, Conversation, WorkItem } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { ownerRef } from "./model/meta.ts";
import { Registry } from "./registry/registry.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { DefaultRecorderFactory, SecretRedactor } from "./transcripts/recorder.ts";
import { createConversationController } from "./runtime/controllers/conversation.ts";
import { DefaultWorkItemRecordReader } from "./agents/work-item-record.ts";
import { workItemDigest } from "./agents/work-item-digest.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const SECRET = "sk-chat-fixture-123456";
const textReply = (text: string) => Response.json({ choices: [{ message: { tool_calls: [{ id: "answer", type: "function", function: { name: "respond", arguments: JSON.stringify({ message: text }) } }] } }] });
const toolReply = (...names: string[]) => Response.json({ choices: [{ message: { tool_calls: names.map((name, i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify({ namespace: "desk" }) } })) } }] });
type RequestBody = { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[]; tool_choice?: string };
const modelFetch = (complete: (body: RequestBody) => Response | Promise<Response>): typeof fetch => async (url, init) => {
  const target = url instanceof Request ? url.url : String(url);
  if (target.includes("/api/mcp")) return new Response("fixture MCP unavailable", { status: 503 });
  return complete(JSON.parse(String(init?.body)) as RequestBody);
};

async function waitFor<T>(read: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("chat did not reach expected state");
}
async function ready(f: Factory, name: string, turn: string) {
  return waitFor(async () => {
    const d = await f.app.getAgentChat(p, name);
    return d?.conversation.status?.completedTurn === turn && d;
  });
}

test("contextual agent chat: fresh work-item evidence and MCP reads are recorded without changing the workflow", async () => {
  const env: Record<string, string | undefined> = {};
  const prompts: RequestBody[] = [];
  const remotes: Server[] = [];
  const invoked: string[] = [];
  const f = await createFactory({
    definitionsRoot: ROOT, databasePath: ":memory:", env,
    fetch: modelFetch((body) => {
      prompts.push(body);
      return body.messages.some((m) => m.role === "tool") ? textReply("Recorded triage needs details; live CR discovery is available.") : toolReply("kubernetes-crs__discover_resources");
    }),
    mcpTransportFor: (definition) => {
      if (definition.metadata.name !== "kubernetes-crs") return undefined;
      const remote = new Server({ name: "context-fixture", version: "1" }, { capabilities: { tools: {} } });
      remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "discover_resources", inputSchema: { type: "object" as const } }] }));
      remote.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        invoked.push(params.name);
        return { content: [{ type: "text", text: '{"resources":[{"kind":"Rover","apiVersion":"example/v1"}],"namespaces":["desk"]}' }] };
      });
      const [client, server] = InMemoryTransport.createLinkedPair();
      remotes.push(remote);
      void remote.connect(server);
      return client;
    },
  });
  await f.start();
  try {
    const item = await f.app.createWorkItem(p, { title: "Contextual investigation", description: "x" });
    await waitFor(async () => (await f.app.getWorkItem(p, item.metadata.name))?.workItem.status?.phase === "Blocked");
    await f.app.updateWorkItemContext(p, item.metadata.name, `Original team note ${SECRET}`);
    await f.manager.settle();
    const before = (await f.app.getWorkItem(p, item.metadata.name))!;
    env.OPENAI_API_KEY = SECRET;
    await assert.rejects(f.app.listAgentChats(p, " "), /workItem must be a non-empty name/);
    await assert.rejects(f.app.startAgentChat(p, "support-engineer", undefined, "missing"), /work item missing not found/);
    await assert.rejects(f.app.startAgentChat(p, "support-engineer", undefined, `factory-system/${item.metadata.name}`), /not found/);
    const c = await f.app.startAgentChat(p, "support-engineer", undefined, item.metadata.name);
    const name = c.metadata.name;
    assert.deepEqual(c.spec.workItemRef, { name: item.metadata.name });
    assert.ok(!c.metadata.ownerReferences?.length);
    assert.equal((await f.app.listAgentChats(p, item.metadata.name)).length, 1);
    assert.equal((await f.app.listAgentChats(p, "another-item")).length, 0);
    await f.app.submitAgentChatTurn(p, name, { id: "context-one", text: "Investigate using this item's evidence" });
    const first = await ready(f, name, "context-one");
    const system = prompts[0].messages[0].content!;
    assert.match(system, /Contextual investigation/);
    assert.match(system, /Original team note/);
    assert.match(system, /## Agent runs/);
    assert.match(system, /## Artifacts/);
    assert.match(system, /## Human input/);
    assert.match(system, /triager/);
    assert.match(system, /Status: Blocked/);
    assert.ok(!system.includes(SECRET) && !JSON.stringify(first).includes(SECRET));
    assert.deepEqual(invoked, ["discover_resources"]);
    assert.ok(prompts[0].tools?.some((t) => t.function.name === "kubernetes-crs__discover_resources"));
    assert.ok(!prompts[0].tools?.some((t) => t.function.name === "run" || t.function.name === "finish"));
    const recorded = first.messages.find((m) => m.role === "system" && m.meta?.turnId === "context-one")!;
    assert.ok(recorded.content.includes("Original team note"));
    const provenance = recorded.meta?.workItemContext;
    assert.ok(provenance && typeof provenance === "object" && "versions" in provenance);
    const versions = provenance.versions;
    const key = `WorkItem/default/${item.metadata.name}`;
    assert.ok(versions && typeof versions === "object");
    assert.ok(Object.entries(versions).some(([resource, version]) => resource === key && version === before.workItem.metadata.resourceVersion));
    const after = (await f.app.getWorkItem(p, item.metadata.name))!;
    assert.deepEqual(after.workItem, before.workItem);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.approvals, before.approvals);
    assert.deepEqual(after.clarifications, before.clarifications);
    await assert.rejects(f.app.createChatWorkItem(p, name, { title: "Duplicate" }), /already has a work item/);
    assert.equal((await f.app.listWorkItems(p)).length, 1);
    const edited = await f.app.updateWorkItemContext(p, item.metadata.name, "New team note: namespace changed");
    const promptCount = prompts.length;
    await f.app.submitAgentChatTurn(p, name, { id: "context-two", text: "Use the updated team context" });
    const second = await ready(f, name, "context-two");
    assert.match(prompts[promptCount].messages[0].content!, /New team note: namespace changed/);
    const secondSnapshot = second.messages.find((m) => m.role === "system" && m.meta?.turnId === "context-two")!;
    assert.ok(JSON.stringify(secondSnapshot.meta?.workItemContext).includes(edited.metadata.resourceVersion!));
    assert.equal(second.messages.find((m) => m.role === "system" && m.meta?.turnId === "context-one")?.content, recorded.content, "prior snapshots stay immutable");
    assert.equal((await f.app.getWorkItem(p, item.metadata.name))?.workItem.status?.phase, "Blocked");
  } finally { await f.stop(); await Promise.all(remotes.map((r) => r.close())); }
});

test("work-item record reader scopes evidence and preserves independent chat history after item deletion", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date() };
  const store = new SqliteStore(db, clock);
  const records = new DefaultWorkItemRecordReader(store);
  const transcripts = new SqliteTranscriptStore(db, clock);
  try {
    const item = await store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "record", namespace: "default" }, spec: { title: "Evidence", sourceRef: { name: "manual" } } });
    const metadata = { name: "owned", namespace: "default", ownerReferences: [ownerRef(item)] };
    await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata, spec: { workItemRef: { name: item.metadata.name }, artifactTypeRef: { name: "research-notes" }, format: "markdown", content: "Research finding" } });
    await store.create<Approval>({ apiVersion: API_VERSION, kind: "Approval", metadata, spec: { workItemRef: { name: item.metadata.name }, stage: "review", approvers: [], decision: "reject", comment: "Human review finding" } });
    await store.create<Artifact>({ apiVersion: API_VERSION, kind: "Artifact", metadata: { ...metadata, namespace: "other" }, spec: { workItemRef: { name: item.metadata.name }, artifactTypeRef: { name: "research-notes" }, format: "markdown", content: "Do not include cross-namespace evidence" } });
    const record = await records.read("default", item.metadata.name);
    assert.equal(record.artifacts.length, 1);
    assert.match(workItemDigest(record), /Research finding/);
    assert.match(workItemDigest(record), /Human review finding/);
    assert.doesNotMatch(workItemDigest(record), /cross-namespace/);
    await store.create<WorkItem>({ ...item, metadata: { name: item.metadata.name, namespace: "other" } });
    const c = await store.create<Conversation>({ apiVersion: API_VERSION, kind: "Conversation", metadata: { name: "context-chat", namespace: "default" }, spec: { purpose: "agent-chat", workItemRef: { name: item.metadata.name } } });
    const ref = await transcripts.open("default", { kind: "Conversation", name: c.metadata.name });
    await transcripts.append(ref, { role: "assistant", author: { type: "agent", id: "support-engineer" }, content: "Retained evidence", meta: { final: true } });
    await store.delete("WorkItem", "default", item.metadata.name);
    await assert.rejects(records.read("default", item.metadata.name), /not found/);
    assert.ok(await store.get("Conversation", "default", c.metadata.name));
    assert.equal((await transcripts.read(ref))[0].content, "Retained evidence");
  } finally { db.close(); }
});

test("work-item evidence digest bounds large records including its truncation marker", () => {
  const workItem: WorkItem = { apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "large" }, spec: { title: "Large evidence", sourceRef: { name: "manual" } } };
  const artifacts: Artifact[] = Array.from({ length: 20 }, (_, i) => ({ apiVersion: API_VERSION, kind: "Artifact", metadata: { name: `a${i}` }, spec: { workItemRef: { name: "large" }, artifactTypeRef: { name: "research-notes" }, format: "markdown", content: "Evidence ".repeat(1000) } }));
  const text = workItemDigest({ workItem, artifacts, runs: [], clarifications: [], approvals: [], events: [] });
  assert.ok(text.length <= 60_000);
  assert.match(text, /record truncated/);
  assert.match(text, /Large evidence/);
});

test("agent chat: durable submission, opt-in, idempotency and one pending turn; no synthetic item", async () => {
  let calls = 0;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch(() => { calls++; return textReply("An ordinary answer"); }) });
  try {
    assert.deepEqual((await f.app.chatAgents(p)).map((a) => a.metadata.name), ["support-engineer"]);
    await assert.rejects(f.app.startAgentChat(p, "developer"), /not enabled/);
    const c = await f.app.startAgentChat(p, "support-engineer");
    const name = c.metadata.name;
    const first = await f.app.submitAgentChatTurn(p, name, { id: "first", text: `Inspect ${SECRET}` });
    assert.ok(!JSON.stringify(first).includes(SECRET), "queued text/title are redacted before execution");
    assert.equal(calls, 0, "HTTP command does not execute the model");
    await f.app.submitAgentChatTurn(p, name, { id: "first", text: `Inspect ${SECRET}` });
    await assert.rejects(f.app.submitAgentChatTurn(p, name, { id: "first", text: "different" }), /different request/);
    await assert.rejects(f.app.submitAgentChatTurn(p, name, { id: "next", text: "different" }), /already pending/);
    await assert.rejects(f.app.createChatWorkItem(p, name, { title: "Not finished" }), /completed chat answer/);
    await assert.rejects(f.app.sendMessage(p, name, "synchronous shortcut"), /durable/);
    assert.equal((await f.app.listWorkItems(p)).length, 0);
    await f.start();
    const finished = await ready(f, name, "first");
    assert.equal(finished.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(calls, 1);
    assert.equal(finished.conversation.metadata.ownerReferences?.length ?? 0, 0);
    assert.equal((await f.app.listAgentChats(p)).length, 1);
  } finally { await f.stop(); }
});

test("agent chat: a discovery announcement is interim, not a final answer or recovery checkpoint", async () => {
  let requests = 0;
  let discoveries = 0;
  const remotes: Server[] = [];
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch(() => {
      requests++;
      if (requests === 1) return Response.json({ choices: [{ message: { content: "I'll start by discovering which resource types I'm allowed to query." } }] });
      if (requests === 2) return toolReply("kubernetes-crs__discover_resources");
      return textReply("Discovery found Rover in namespace desk.");
    }),
    mcpTransportFor: (definition) => {
      if (definition.metadata.name !== "kubernetes-crs") return undefined;
      const remote = new Server({ name: "discovery-fixture", version: "1" }, { capabilities: { tools: {} } });
      remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "discover_resources", inputSchema: { type: "object" as const } }] }));
      remote.setRequestHandler(CallToolRequestSchema, async () => {
        discoveries++;
        return { content: [{ type: "text", text: '{"kind":"Rover","namespace":"desk"}' }] };
      });
      const [client, server] = InMemoryTransport.createLinkedPair();
      remotes.push(remote);
      void remote.connect(server);
      return client;
    },
  });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "discovery", text: "Discover the available cluster resources" });
    const done = await ready(f, c.metadata.name, "discovery");
    assert.equal(requests, 3, "the loop must continue past the announcement");
    assert.equal(discoveries, 1);
    const announcement = done.messages.find((m) => m.content.startsWith("I'll start"));
    assert.equal(announcement?.meta?.final, false);
    const final = done.messages.filter((m) => m.meta?.final === true);
    assert.equal(final.length, 1);
    assert.equal(final[0].content, "Discovery found Rover in namespace desk.");
    assert.ok(done.messages.some((m) => m.role === "tool-result" && m.meta?.tool === "kubernetes-crs__discover_resources"));
  } finally { await f.stop(); await Promise.all(remotes.map((r) => r.close())); }
});

test("agent chat: models that keep announcing work fail within the step budget without a false final answer", async () => {
  let requests = 0;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch((body) => {
      requests++;
      assert.equal(body.tool_choice, undefined, "do not require provider-specific forced tool selection");
      assert.ok(body.tools?.some((t) => t.function.name === "respond"));
      return Response.json({ choices: [{ message: { content: "I'll investigate now." } }] });
    }) });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "never-done", text: "Investigate the cluster" });
    const done = await waitFor(async () => {
      const d = await f.app.getAgentChat(p, c.metadata.name);
      return (d?.conversation.status?.phase === "Failed" || d?.conversation.status?.phase === "Ready") && d;
    });
    assert.equal(done.conversation.status?.phase, "Failed");
    assert.match(done.conversation.status?.message ?? "", /20 model steps/);
    assert.equal(requests, 20);
    assert.ok(!done.messages.some((m) => m.meta?.final === true));
    assert.ok(done.messages.some((m) => m.role === "note" && m.content.startsWith("Failed:")));
  } finally { await f.stop(); }
});

test("agent chat: mixed and empty completion calls cannot hide pending reads or grant execution permissions", async () => {
  let requests = 0;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch(() => {
      requests++;
      if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [
        { id: "early", type: "function", function: { name: "respond", arguments: '{"message":"Premature answer"}' } },
        { id: "denied", type: "function", function: { name: "run", arguments: '{"command":"not executed"}' } },
      ] } }] });
      if (requests === 2) return textReply(" ");
      return textReply("Shell execution is unavailable in this read-only chat.");
    }) });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "invalid-completion", text: "Explain the available investigation tools" });
    const done = await ready(f, c.metadata.name, "invalid-completion");
    assert.equal(requests, 3);
    assert.equal(done.messages.filter((m) => m.role === "tool-result" && m.meta?.tool === "respond" && m.content.startsWith("error:")).length, 2);
    assert.ok(done.messages.some((m) => m.role === "tool-result" && m.meta?.tool === "run" && m.content.includes("disallowed")));
    assert.deepEqual(done.messages.filter((m) => m.meta?.final === true).map((m) => m.content), ["Shell execution is unavailable in this read-only chat."]);
  } finally { await f.stop(); }
});

test("agent chat: real MCP recording, denied tool injection, bounded history, redaction and human-only idempotent handoff", async () => {
  const remotes: Server[] = [];
  const invoked: string[] = [];
  const offered: string[][] = [];
  let followup: RequestBody | undefined;
  const llm: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    offered.push(body.tools?.map((t) => t.function.name) ?? []);
    if (body.messages.some((m) => m.role === "user" && m.content === "Summarize the finding")) {
      followup = body;
      return textReply("The Rover is not Ready.");
    }
    const results = body.messages.filter((m) => m.role === "tool").length;
    if (!results) return toolReply("kubernetes-crs__discover_resources");
    if (results === 1) return toolReply("kubernetes-crs__get_resource");
    if (results === 2) return toolReply("kubernetes-crs__delete_resource", "run", "factory__create_work_item");
    assert.equal(results, 5);
    assert.ok(body.messages.filter((m) => m.role === "tool").slice(-3).every((m) => m.content?.includes("disallowed tool")));
    return textReply(`Rover desk/ticket-rover resourceVersion 42 is not Ready. ${SECRET}`);
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: llm, mcpTransportFor: (definition) => {
      const remote = new Server({ name: "chat-read-fixture", version: "1" }, { capabilities: { tools: {} } });
      remote.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["discover_resources", "get_resource", "list_resources", "get_resource_hierarchy", "delete_resource", "search_knowledge", "create_work_item"].map((name) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: true } })),
      }));
      remote.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        invoked.push(`${definition.metadata.name}__${params.name}`);
        return { content: [{ type: "text", text: JSON.stringify({ kind: "Rover", metadata: { name: "ticket-rover", namespace: "desk", resourceVersion: "42" }, status: { ready: false }, token: SECRET }) }] };
      });
      const [client, server] = InMemoryTransport.createLinkedPair();
      remotes.push(remote);
      void remote.connect(server);
      return client;
    } });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    const name = c.metadata.name;
    await f.app.submitAgentChatTurn(p, name, { id: "one", text: "Investigate the Rover" });
    const first = await ready(f, name, "one");
    assert.deepEqual(invoked, ["kubernetes-crs__discover_resources", "kubernetes-crs__get_resource"]);
    assert.ok(offered.every((names) => names.length === 6 && names.includes("respond") && names.includes("factory__search_knowledge") && !names.includes("finish") && !names.includes("run") && !names.includes("kubernetes-crs__delete_resource")));
    assert.ok(!JSON.stringify(first).includes(SECRET));
    assert.ok(first.messages.some((m) => m.role === "tool-result" && m.meta?.tool === "kubernetes-crs__get_resource" && m.meta.turnId === "one" && m.content.includes("42")));
    assert.ok(first.messages.some((m) => m.role === "note" && m.meta?.model));
    assert.ok(first.messages.some((m) => m.role === "system" && m.meta?.agentVersion && m.meta.skills));
    await f.app.submitAgentChatTurn(p, name, { id: "two", text: "Summarize the finding" });
    const second = await ready(f, name, "two");
    assert.ok(followup?.messages.some((m) => m.role === "assistant" && m.content?.includes("resourceVersion 42")));
    assert.ok(!followup?.messages.some((m) => m.role === "tool"), "partial/tool attempts are not replayed as malformed history");
    await f.app.submitAgentChatTurn(p, name, { id: "one", text: "Investigate the Rover" });
    assert.equal((await f.app.getAgentChat(p, name))?.conversation.spec.turn?.id, "two", "old retries cannot replace the current turn");
    assert.equal(second.messages.filter((m) => m.role === "user").length, 2);
    assert.equal((await f.app.listWorkItems(p)).length, 0, "read-only chat never makes items itself");
    await f.manager.stop();
    const input = { title: `Reviewed ${SECRET}`, description: `Investigate ${SECRET}`, workflowRef: "servicedesk", repositoryRefs: ["software-factory"] };
    const [item, duplicate] = await Promise.all([f.app.createChatWorkItem(p, name, input), f.app.createChatWorkItem(p, name, input)]);
    assert.equal(item.metadata.name, duplicate.metadata.name);
    assert.equal(item.spec.conversationRef?.name, name);
    assert.equal(item.spec.workflowRef?.name, "servicedesk");
    assert.deepEqual(item.spec.repositoryRefs, [{ name: "software-factory" }]);
    assert.match(item.spec.context!, /Transcript: default\//);
    assert.match(item.spec.context!, /resourceVersion 42/);
    assert.ok(item.spec.context!.length <= 20_000);
    assert.ok(!JSON.stringify(item).includes(SECRET));
    const again = await f.app.createChatWorkItem(p, name, { title: "Do not replace human edits" });
    assert.equal(again.spec.title, item.spec.title);
    assert.equal((await f.app.listWorkItems(p)).length, 1);
    assert.ok(!(await f.app.getAgentChat(p, name))?.conversation.metadata.ownerReferences?.length);
    assert.ok(!f.exposedTools.some((t) => /chat/.test(t.name)), "handoff is not an agent MCP tool");
  } finally { await f.stop(); await Promise.all(remotes.map((r) => r.close())); }
});

test("agent chat: quota waits visibly then retries without duplicating user messages", async () => {
  let attempts = 0;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET }, fetch: modelFetch(() => {
    if (++attempts === 1) return new Response("quota exhausted", { status: 429, headers: { "retry-after": "1" } });
    return textReply("The model recovered");
  }) });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "quota", text: "Investigate quota" });
    const waiting = await waitFor(async () => {
      const d = await f.app.getAgentChat(p, c.metadata.name);
      return d?.conversation.status?.phase === "Waiting" && d;
    });
    assert.ok(waiting.conversation.status?.retryAt);
    assert.match(waiting.conversation.status?.message ?? "", /429|quota/);
    const done = await ready(f, c.metadata.name, "quota");
    assert.equal(attempts, 2);
    assert.equal(done.messages.filter((m) => m.role === "user").length, 1);
    assert.ok(done.messages.some((m) => m.role === "note" && m.content.includes("Waiting")));
  } finally { await f.stop(); }
});

test("agent chat: missing model waits (no simulated answer), persisted turn resumes after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-agent-chat-"));
  const databasePath = join(dir, "test.sqlite");
  let f = await createFactory({ definitionsRoot: ROOT, databasePath, env: {} });
  let stopped = false;
  try {
    await f.start();
    const c = await f.app.startAgentChat(p, "support-engineer");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "restart", text: "A persistent investigation" });
    const waiting = await waitFor(async () => {
      const d = await f.app.getAgentChat(p, c.metadata.name);
      return d?.conversation.status?.phase === "Waiting" && d;
    });
    assert.match(waiting.conversation.status?.message ?? "", /No tool-calling model/);
    assert.equal(waiting.messages.filter((m) => m.role === "assistant").length, 0);
    await f.stop(); stopped = true;
    f = await createFactory({ definitionsRoot: ROOT, databasePath, env: { OPENAI_API_KEY: SECRET },
      clock: { now: () => new Date(Date.now() + 61_000) }, fetch: modelFetch(() => textReply("Recovered on the new process")) });
    stopped = false;
    await f.start();
    const done = await ready(f, c.metadata.name, "restart");
    assert.equal(done.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(done.messages.filter((m) => m.meta?.final === true).length, 1);
  } finally { if (!stopped) await f.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("agent chat: hard failures are visible and a new turn can explicitly retry", async () => {
  let attempts = 0;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch(() => ++attempts === 1 ? new Response("invalid request", { status: 400 }) : textReply("Retry answered")) });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    const text = "Investigate the CR";
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "failed", text });
    const failed = await waitFor(async () => {
      const d = await f.app.getAgentChat(p, c.metadata.name);
      return d?.conversation.status?.phase === "Failed" && d;
    });
    assert.match(failed.conversation.status?.message ?? "", /400|invalid request/);
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "failed", text });
    assert.equal(attempts, 1, "same request id never re-executes, even after failure");
    await f.app.submitAgentChatTurn(p, c.metadata.name, { id: "retry", text });
    const done = await ready(f, c.metadata.name, "retry");
    assert.equal(attempts, 2);
    assert.ok(done.messages.some((m) => m.role === "note" && m.content.includes("Failed")));
  } finally { await f.stop(); }
});

test("agent chat: model history retains the latest question and stays below 60000 characters", async () => {
  let latest: RequestBody | undefined;
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: SECRET },
    fetch: modelFetch((body) => { latest = body; return textReply("Evidence ".repeat(3100)); }) });
  await f.start();
  try {
    const c = await f.app.startAgentChat(p, "support-engineer");
    for (let i = 0; i < 4; i++) {
      await f.app.submitAgentChatTurn(p, c.metadata.name, { id: `turn${i}`, text: `${i}: ${"Question ".repeat(2000)}` });
      await ready(f, c.metadata.name, `turn${i}`);
    }
    const history = latest!.messages.filter((m) => m.role !== "system");
    assert.ok(history.reduce((n, m) => n + (m.content?.length ?? 0), 0) <= 60_000);
    assert.ok(history.length <= 40);
    assert.match(history.at(-1)?.content ?? "", /^3:/);
    assert.ok(!history.some((m) => m.content?.startsWith("0:")), "old exchanges really are dropped at the limit");
    const d = await f.app.getAgentChat(p, c.metadata.name);
    assert.equal(d?.messages.filter((m) => m.role === "user").length, 4, "full transcript survives context trimming");
    assert.ok(d?.messages.some((m) => m.role === "note" && m.content.includes("Earlier history omitted")));
  } finally { await f.stop(); }
});

test("conversation controller: in-flight serialization and crash after final append recover without duplicate model execution", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date() };
  const store = new SqliteStore(db, clock);
  const transcripts = new SqliteTranscriptStore(db, clock);
  const redactor = new SecretRedactor();
  const recorders = new DefaultRecorderFactory(transcripts, redactor);
  const registry = new Registry<ConversationTurnRunner>();
  const errors: string[] = [];
  const events = { normal: async () => {}, warning: async () => {} };
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  registry.register("agent-chat", { run: async (_c, recorder) => {
    calls++;
    await hold;
    await recorder.record({ role: "assistant", author: { type: "agent", id: "support-engineer" }, content: "Already recorded", meta: { turnId: "crash", final: true } });
  } });
  const c = await store.create<Conversation>({ apiVersion: API_VERSION, kind: "Conversation", metadata: { name: "chat-crash", namespace: "default" },
    spec: { purpose: "agent-chat", agentRef: { name: "support-engineer" }, turn: { id: "crash", text: "investigate", submittedBy: p.id } } });
  const recorder = await recorders.forConversation(c);
  await store.updateStatus({ ...c, status: { phase: "Running", activeTurn: "crash", transcriptRef: recorder.ref } });
  let conflict = true;
  const status = { updateStatus: async <R extends import("./model/resource.ts").Resource>(r: R): Promise<R> => {
    if (conflict && (r.status as Conversation["status"])?.phase === "Ready") {
      conflict = false;
      throw new StoreError("simulated crash gap conflict", "Conflict");
    }
    return store.updateStatus(r);
  } };
  const deps = { reader: store, status, recorders, transcripts, turns: registry, clock, redactor, events, onError: (message: string) => { errors.push(message); } };
  const controller = createConversationController(deps);
  try {
    await controller.reconcile("default/chat-crash");
    await controller.reconcile("default/chat-crash");
    await waitFor(async () => calls === 1);
    assert.equal(calls, 1);
    release();
    await controller.stop();
    assert.equal((await store.get<Conversation>("Conversation", "default", c.metadata.name))?.status?.phase, "Running");
    const restarted = createConversationController(deps);
    assert.deepEqual(await restarted.initialKeys(), ["default/chat-crash"]);
    await restarted.reconcile("default/chat-crash");
    await restarted.stop();
    assert.equal(calls, 1, "final transcript answer is the completion idempotency key");
    assert.equal((await store.get<Conversation>("Conversation", "default", c.metadata.name))?.status?.completedTurn, "crash");
    assert.equal((await transcripts.read(recorder.ref)).length, 1);
    assert.deepEqual(errors, []);
  } finally { release(); await controller.stop(); db.close(); }
});
