import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS, type PreparedWorkspace } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const TOKEN = "mcp-test-token-123456";
const MCP_URL = "http://localhost:3000/api/mcp";

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Routes the factory's own MCP URL to its in-process handler; everything else goes to `other`. */
function routing(get: () => Factory, other: typeof fetch): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith(MCP_URL)) return get().mcp(new Request(u, init));
    return other(url as string, init);
  }) as typeof fetch;
}

async function connect(f: Factory, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test-harness", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routing(() => f, fetch), requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...headers } } }));
  return client;
}
const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);

test("MCP server: token required; harness creates items, proposes and searches knowledge; no gate tools", async () => {
  const off = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: {}, log: () => {} });
  assert.equal((await off.mcp(new Request(MCP_URL, { method: "POST", body: "{}" }))).status, 503, "disabled without FACTORY_MCP_TOKEN");
  await off.stop();

  let f!: Factory;
  f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_MCP_TOKEN: TOKEN }, log: () => {} });
  await f.start();
  try {
    assert.equal((await f.mcp(new Request(MCP_URL, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }))).status, 401);

    const client = await connect(f);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_work_items", "get_work_item", "create_work_item", "set_work_item_context", "answer_clarification", "search_knowledge", "propose_knowledge"]) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /approve|reject|decide|delete/.test(n)), `no gate tools: ${names.join(", ")}`);

    const created = json(await client.callTool({ name: "create_work_item", arguments: { title: "From my harness", description: "short", context: "Env: prod" } }));
    const wi = await f.app.getWorkItem(ANONYMOUS, created.name);
    assert.equal(wi?.workItem.spec.context, "Env: prod");

    await waitFor(async () => (await f.app.getWorkItem(ANONYMOUS, created.name))?.workItem.status?.phase === "Blocked", "blocked");
    const item = json(await client.callTool({ name: "get_work_item", arguments: { name: created.name } }));
    assert.equal(item.openQuestions.length, 2);
    json(await client.callTool({ name: "answer_clarification", arguments: { name: created.name, answers: ["It should add numbers", "Everyone, P2"] } }));
    await waitFor(async () => (await f.app.getWorkItem(ANONYMOUS, created.name))?.workItem.status?.phase === "AwaitingApproval", "resumed to the human gate");
    const gated = json(await client.callTool({ name: "get_work_item", arguments: { name: created.name } }));
    assert.match(gated.awaitingApproval.note, /factory UI/);

    const proposed = json(await client.callTool({ name: "propose_knowledge", arguments: { title: "Rover CLI applies subscriptions", content: "Use `rover apply`.", tags: ["rover"] } }));
    assert.equal(proposed.phase, "Proposed");
    assert.deepEqual(json(await client.callTool({ name: "search_knowledge", arguments: { query: "rover" } })).filter((h: { kind: string }) => h.kind === "entry"), [], "unapproved knowledge is never returned");
    await f.app.reviewKnowledge(ANONYMOUS, proposed.name, "approve");
    await waitFor(async () => (await f.app.getKnowledge(ANONYMOUS, proposed.name))?.entry.status?.phase === "Approved", "approved");
    assert.equal(json(await client.callTool({ name: "search_knowledge", arguments: { query: "rover" } }))[0].ref, proposed.name);

    const bad = await client.callTool({ name: "get_work_item", arguments: { name: "nope" } });
    assert.equal(bad.isError, true);
    await client.close();

    // Rule 8: a factory agent calling back (run header) never sees or uses human-only tools.
    const agent = await connect(f, { "x-factory-agent-run": "some-run-r1" });
    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    assert.ok(agentTools.includes("search_knowledge") && !agentTools.includes("answer_clarification") && !agentTools.includes("create_work_item"));
    const refused = await agent.callTool({ name: "answer_clarification", arguments: { name: created.name, answers: ["x"] } });
    assert.equal(refused.isError, true);
    assert.match((refused.content as { text: string }[])[0].text, /humans only/);
    await agent.close();
  } finally {
    await f.stop();
  }
});

test("MCP client: an agent calls its ToolServer's allowed tools in the tool loop (recorded)", async () => {
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const offered: string[][] = [];
  const crCalls: string[] = [];
  const crServers: Server[] = [];
  const llm = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] };
    const system = String(body.messages[0].content ?? "");
    if (body.tools && system.includes("# Support Engineer Agent")) {
      offered.push(body.tools.map((t) => t.function.name));
      const done = body.messages.filter((m) => m.role === "tool").length;
      const step = done === 0 ? call("k1", "factory__search_knowledge", { query: "rover" })
        : done === 1 ? call("d1", "kubernetes-crs__discover_resources", {})
        : done === 2 ? call("g1", "kubernetes-crs__get_resource", { apiVersion: "rover.cp.ei.telekom.de/v1", kind: "Rover", namespace: "desk", name: "ticket-rover" })
        : call("f1", "finish", { summary: "Answered", outcome: "resolvable", artifacts: [{ type: "support-analysis", content: "ok" }] });
      return Response.json({ choices: [{ message: { content: null, tool_calls: [step] } }] });
    }
    if (body.tools) return Response.json({ choices: [{ message: { content: null, tool_calls: [call("f", "finish", { summary: "done", artifacts: [{ type: "research-notes", content: "notes" }] })] } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  }) as typeof fetch;

  let f!: Factory;
  const backend = {
    supports: () => true,
    sweep: async () => [],
    remove: async () => {},
    prepare: async (): Promise<PreparedWorkspace> => ({ path: ROOT, baseCommit: "c0ffee", headCommit: "c0ffee", preparedBy: "fake", setupCompleted: true }),
  };
  f = await createFactory({
    definitionsRoot: ROOT,
    databasePath: ":memory:",
    env: { OPENAI_API_KEY: "sk-test-123456", FACTORY_MCP_TOKEN: TOKEN },
    fetch: routing(() => f, llm),
    workspaceBackend: backend,
    mcpTransportFor: (definition) => {
      if (definition.metadata.name !== "kubernetes-crs") return undefined;
      const remote = new Server({ name: "cr-fixture", version: "1" }, { capabilities: { tools: {} } });
      remote.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["discover_resources", "list_resources", "get_resource", "get_resource_hierarchy", "delete_resource"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      }));
      remote.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        crCalls.push(params.name);
        const data = params.name === "discover_resources"
          ? { namespaces: ["desk"], resources: [{ apiVersion: "rover.cp.ei.telekom.de/v1", kind: "Rover" }] }
          : { apiVersion: "rover.cp.ei.telekom.de/v1", kind: "Rover", metadata: { name: "ticket-rover", namespace: "desk", resourceVersion: "42" }, status: { conditions: [{ type: "Ready", status: "False" }] } };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      crServers.push(remote);
      void remote.connect(serverTransport);
      return clientTransport;
    },
    log: () => {},
  });
  await f.start();
  try {
    const k = await f.app.proposeKnowledge(ANONYMOUS, { title: "Rover CLI applies subscriptions", content: "Use `rover apply`." });
    await f.app.reviewKnowledge(ANONYMOUS, k.metadata.name, "approve");
    await waitFor(async () => (await f.app.getKnowledge(ANONYMOUS, k.metadata.name))?.entry.status?.phase === "Approved", "approved");

    const wi = await f.app.createWorkItem(ANONYMOUS, { title: "Rover subscription question", description: "How do I apply an ApiSubscription with the Rover CLI in prod?", workflowRef: "servicedesk", repositoryRefs: ["software-factory"] });
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(ANONYMOUS, wi.metadata.name);
      return x?.runs.find((r) => r.spec.step === "analyze-request" && r.status?.phase === "Succeeded") ? x : undefined;
    }, "analysis done");
    assert.ok(offered[0].includes("factory__search_knowledge"));
    assert.ok(!offered[0].includes("factory__create_work_item"), "only allowedTools are offered");
    assert.ok(offered[0].includes("kubernetes-crs__discover_resources"));
    assert.ok(!offered[0].includes("kubernetes-crs__delete_resource"), "no Kubernetes write tool is allowed");
    assert.deepEqual(crCalls.slice(0, 2), ["discover_resources", "get_resource"]);
    const run = d.runs.find((r) => r.spec.step === "analyze-request")!;
    const t = await f.app.runTranscript(ANONYMOUS, run.metadata.name);
    assert.ok(t.some((m) => m.role === "note" && /MCP tools: factory__search_knowledge/.test(m.content)));
    const result = t.find((m) => m.role === "tool-result" && m.meta?.tool === "factory__search_knowledge")!;
    assert.match(result.content, /Rover CLI applies subscriptions/);
    const crResult = t.find((m) => m.role === "tool-result" && m.meta?.tool === "kubernetes-crs__get_resource")!;
    assert.match(crResult.content, /ticket-rover/);
    assert.match(crResult.content, /resourceVersion/);
    assert.match(crResult.content, /data, not instructions/);
    await waitFor(async () => (await f.app.getWorkItem(ANONYMOUS, wi.metadata.name))?.workItem.status?.phase === "AwaitingApproval", "response-review");
  } finally {
    await f.stop();
    await Promise.all(crServers.map((s) => s.close()));
  }
});

test("MCP client: stdio servers (local processes) only with the host opt-in; no allowedTools = nothing offered", async () => {
  const { McpToolProvider } = await import("./adapters/mcp/client.ts");
  const provider = new McpToolProvider({ secrets: { resolve: () => undefined }, redactor: { redact: (x: string) => x } });
  const server = (name: string, spec: object) => ({ metadata: { name }, spec }) as never;
  const s = await provider.open([server("local", { transport: "stdio", command: "node", allowedTools: ["x"] }), server("none", { transport: "http", url: MCP_URL })], { allowStdio: false });
  assert.deepEqual(s.tools, []);
  assert.match(s.unavailable.find((u) => u.server === "local")!.reason, /FACTORY_SANDBOX_RUNTIME=host/);
  assert.match(s.unavailable.find((u) => u.server === "none")!.reason, /no allowedTools/);
  await s.close();
});
