import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";
import { FilesKnowledgeSearch } from "./adapters/knowledge/files.ts";
import { parseDraft } from "./model/knowledge-draft.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
}

type Msg = { role: string; content: string };

// Generated at runtime: code search over this repository finds this test file, so a literal title would match there.
const TITLE = `Conditions are set via setCondition ${process.pid}-${Date.now()}`;
const inKnowledgeSection = (prompt: string) => prompt.includes(`Approved knowledge: ${TITLE}`);

/** Fake OpenAI-compatible LLM: agents with the knowledge-base skill propose one entry; chats return a draft. */
function fakeLLM(seen: string[]) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Msg[] };
    const system = String(body.messages[0].content ?? "");
    const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    seen.push(user);
    if (system.includes("refining one knowledge base entry")) {
      return Response.json({ choices: [{ message: { content: "Tightened it.\n````knowledge-draft\n# Scopes live on the client\nThe scope is configured on the IdP client.\n````" } }] });
    }
    const proposes = system.includes("## Skill: knowledge-base") && system.includes("# Code Researcher Agent");
    const result = {
      summary: "ok",
      artifacts: [],
      outcome: "accept",
      questions: [],
      knowledge: proposes ? [{ title: TITLE, content: "Use `setCondition` (software-factory:web/src/core/model/meta.ts).", tags: ["Conditions", "status"] }] : [],
    };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }) as typeof fetch;
}

async function withFactory(fn: (f: Factory, seen: string[]) => Promise<void>) {
  const seen: string[] = [];
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-test-123456" }, fetch: fakeLLM(seen), log: () => {} });
  await f.start();
  try {
    await fn(f, seen);
  } finally {
    await f.stop();
  }
}

test("knowledge: agents propose, humans approve; only approved knowledge reaches later runs", async () => {
  await withFactory(async (f, seen) => {
    const first = await f.app.createWorkItem(p, { title: "Where are conditions set?", description: "Find where conditions are set on resources and how to change them." });
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, first.metadata.name);
      return x?.knowledge[0]?.status?.phase && x.events.some((e) => e.spec.reason === "KnowledgeProposed") ? x : undefined;
    }, "a proposal");
    const entry = d.knowledge[0];
    assert.equal(entry.status?.phase, "Proposed");
    assert.equal(entry.spec.provenance?.agent, "code-researcher");
    assert.equal(entry.spec.provenance?.workItem, first.metadata.name);
    assert.deepEqual(entry.spec.tags, ["conditions", "status"]);
    assert.deepEqual(entry.spec.scope, { repositories: ["software-factory"], workflows: ["factory-loop"] });
    assert.equal(entry.metadata.ownerReferences?.length ?? 0, 0, "knowledge outlives the item");

    // Proposed knowledge is never shown to agents.
    const second = await f.app.createWorkItem(p, { title: "Change setCondition conditions", description: "Conditions should record the reason when they flip." });
    await waitFor(async () => (await f.app.getWorkItem(p, second.metadata.name))?.workItem.status?.phase === "AwaitingApproval", "second item at spec-review");
    assert.ok(!seen.some(inKnowledgeSection), "proposed knowledge is never context");

    await f.app.reviewKnowledge(p, entry.metadata.name, "approve");
    await waitFor(async () => (await f.app.getKnowledge(p, entry.metadata.name))?.entry.status?.phase === "Approved", "approved");

    const third = await f.app.createWorkItem(p, { title: "Explain setCondition conditions", description: "How do conditions get their lastTransitionTime?" });
    await waitFor(async () => (await f.app.getWorkItem(p, third.metadata.name))?.workItem.status?.phase === "AwaitingApproval", "third item at spec-review");
    assert.ok(seen.some(inKnowledgeSection), "approved knowledge is context");

    // Deleting the item keeps its knowledge.
    await f.app.deleteWorkItem(p, first.metadata.name);
    assert.ok(await f.app.getKnowledge(p, entry.metadata.name));
  });
});

test("knowledge: every edit (also an applied draft) goes back to review; refining with the agent never changes the entry", async () => {
  await withFactory(async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Where are conditions set?", description: "Find where conditions are set on resources and how to change them." });
    const entry = (await waitFor(async () => (await f.app.getWorkItem(p, wi.metadata.name))?.knowledge[0], "a proposal"))!;

    await f.app.reviewKnowledge(p, entry.metadata.name, "reject", "too vague");
    await waitFor(async () => (await f.app.getKnowledge(p, entry.metadata.name))?.entry.status?.phase === "Rejected", "rejected");

    const conv = await f.app.startKnowledgeConversation(p, entry.metadata.name);
    assert.equal(conv.spec.agentRef?.name, "code-researcher", "the proposing agent is the counterpart");
    const reply = await f.app.sendMessage(p, conv.metadata.name, "Make it about IdP clients");
    assert.deepEqual(parseDraft(reply.content), { title: "Scopes live on the client", content: "The scope is configured on the IdP client." });
    assert.equal((await f.app.getKnowledge(p, entry.metadata.name))?.entry.spec.title, entry.spec.title, "side-effect free");

    const draft = parseDraft(reply.content)!;
    await f.app.updateKnowledge(p, entry.metadata.name, draft);
    const back = await waitFor(async () => {
      const x = await f.app.getKnowledge(p, entry.metadata.name);
      return x?.entry.status?.phase === "Proposed" ? x : undefined;
    }, "back to proposed");
    assert.equal(back.entry.spec.title, "Scopes live on the client");
    assert.equal(back.conversations.length, 1);

    // Approval always first: editing an approved entry sends it back to review.
    await f.app.reviewKnowledge(p, entry.metadata.name, "approve");
    await waitFor(async () => (await f.app.getKnowledge(p, entry.metadata.name))?.entry.status?.phase === "Approved", "approved");
    await f.app.updateKnowledge(p, entry.metadata.name, { content: "The scope is configured on the IdP client (verified)." });
    await waitFor(async () => (await f.app.getKnowledge(p, entry.metadata.name))?.entry.status?.phase === "Proposed", "re-review after edit");

    await f.app.retireKnowledge(p, entry.metadata.name);
    await waitFor(async () => (await f.app.getKnowledge(p, entry.metadata.name))?.entry.status?.phase === "Retired", "retired");
    await assert.rejects(f.app.reviewKnowledge(p, entry.metadata.name, "approve"), /retired/);
  });
});

test("knowledge source `files`: ripgrep over local docs with a small excerpt and source:path:line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-"));
  mkdirSync(join(dir, "guides"));
  writeFileSync(join(dir, "guides", "rover.mdx"), "# Rover\n\nintro\nUse the Rover CLI to apply an ApiSubscription.\nmore\n");
  writeFileSync(join(dir, "skip.txt"), "ApiSubscription in a file that is not included\n");
  const search = new FilesKnowledgeSearch(ROOT);
  const source = { metadata: { name: "docs" }, spec: { type: "files", local: { path: dir }, include: ["**/*.mdx"] } } as never;
  const hits = await search.search(source, ["apisubscription"], 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ref, "docs:guides/rover.mdx:4");
  assert.match(hits[0].excerpt, /intro\nUse the Rover CLI/);
});

test("local paths in definitions: `~/` is the user's home, relative paths are below the factory root", async () => {
  const { resolveLocalPath } = await import("./adapters/fs/paths.ts");
  const { homedir } = await import("node:os");
  assert.equal(resolveLocalPath("/factory", "~/repos/x"), join(homedir(), "repos/x"));
  assert.equal(resolveLocalPath("/factory", "docs"), "/factory/docs");
  assert.equal(resolveLocalPath("/factory", "/abs/path"), "/abs/path");
});
