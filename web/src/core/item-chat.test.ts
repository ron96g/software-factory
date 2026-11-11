import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

async function blockedItem(env: Record<string, string>, fetchImpl?: typeof fetch) {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env, fetch: fetchImpl, log: () => {} });
  await f.start();
  const wi = await f.app.createWorkItem(p, { title: "Ask the item", description: "x" });
  for (let i = 0; i < 400; i++) {
    const d = await f.app.getWorkItem(p, wi.metadata.name);
    if (d?.workItem.status?.phase === "Blocked") break;
    await new Promise((r) => setTimeout(r, 15));
  }
  return { f, name: wi.metadata.name };
}

test("X4: item-level chat without LLM lists what the named agent did", async () => {
  const { f, name } = await blockedItem({});
  try {
    const conv = await f.app.startItemConversation(p, name);
    assert.equal(conv.spec.purpose, "explain-item");
    const a = await f.app.sendMessage(p, conv.metadata.name, "What did the triager do?");
    assert.match(a.content, /for triager/);
    assert.match(a.content, /triage\/triage-signal/);
    assert.doesNotMatch(a.content, /code-researcher/, "filtered to the asked agent");
    const d = (await f.app.getWorkItem(p, name))!;
    assert.equal(d.workItem.status?.phase, "Blocked", "side-effect free");
  } finally {
    await f.stop();
  }
});

test("X4: item-level chat with LLM gets a digest of all runs, artifacts and human input", async () => {
  let system = "";
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[]; response_format?: unknown };
    if (!body.response_format && body.messages[0].content.includes("explain mode")) {
      system = body.messages[0].content;
      return Response.json({ choices: [{ message: { content: "The triager asked for details (round 2)." } }] });
    }
    // agents: thin description → ask questions so the item blocks
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "need info", outcome: "needs-info", questions: ["What exactly?"], artifacts: [] }) } }] });
  }) as typeof fetch;
  const { f, name } = await blockedItem({ OPENAI_API_KEY: "sk-test-123456" }, fetchImpl);
  try {
    const conv = await f.app.startItemConversation(p, name);
    const a = await f.app.sendMessage(p, conv.metadata.name, "Why is it blocked?");
    assert.equal(a.content, "The triager asked for details (round 2).");
    assert.match(system, /## Agent runs/);
    assert.match(system, /\*\*triager\*\* · classify\/auto-classify · round 1/);
    assert.match(system, /## Human input/);
    assert.match(system, /What exactly\?/);
  } finally {
    await f.stop();
  }
});
