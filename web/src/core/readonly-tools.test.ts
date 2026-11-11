import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS, type PreparedWorkspace } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

type Msg = { role: string; content?: string | null };

test("S5b: analysis agents read the workspace with read-only tools (no sandbox); code is cited from real files", async () => {
  const toolSets: Record<string, string[]> = {};
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const research = [
    call("r1", "search_code", { query: "export function setCondition" }),
    call("r2", "read_file", { path: "web/src/core/model/meta.ts" }),
    call("r3", "finish", {
      summary: "setCondition lives in web/src/core/model/meta.ts.",
      artifacts: [{ type: "research-notes", content: "Affected: `software-factory:web/src/core/model/meta.ts` (setCondition)." }],
    }),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Msg[]; tools?: { function: { name: string } }[] };
    const system = String(body.messages[0].content ?? "");
    const agent = /^# (\w[\w ]*?) Agent/m.exec(system)?.[1] ?? "?";
    if (body.tools) {
      toolSets[agent] = body.tools.map((t) => t.function.name);
      if (agent === "Code Researcher") {
        const done = body.messages.filter((m) => m.role === "tool").length;
        return Response.json({ choices: [{ message: { content: null, tool_calls: [research[done]] } }] });
      }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [call("f", "finish", { summary: `${agent} done`, outcome: "accept" })] } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  }) as typeof fetch;

  const backend = {
    supports: () => true,
    sweep: async () => [],
    remove: async () => {},
    prepare: async (): Promise<PreparedWorkspace> => ({ path: ROOT, baseCommit: "c0ffee", headCommit: "c0ffee", preparedBy: "fake", setupCompleted: true }),
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-test-123456" }, fetch: fetchImpl, workspaceBackend: backend, log: () => {} });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Where is setCondition?", description: "Find where conditions are set on resources and describe the impact of changing it." });
    let d = null;
    for (let i = 0; i < 400; i++) {
      d = await f.app.getWorkItem(p, wi.metadata.name);
      if (d?.workItem.status?.stage === "spec-review") break;
      if (d?.workItem.status?.phase === "Failed") assert.fail(d.workItem.status.message);
      await new Promise((r) => setTimeout(r, 20));
    }
    const research = d!.runs.find((r) => r.spec.step === "research-impact")!;
    assert.equal(research.status?.provenance?.executor, "tool-loop");
    const t = await f.app.runTranscript(p, research.metadata.name);
    assert.ok(t.some((m) => m.role === "note" && /read-only workspace access: software-factory@c0ffee/.test(m.content)));
    const results = t.filter((m) => m.role === "tool-result").map((m) => m.content);
    assert.match(results[0], /software-factory:web\/src\/core\/model\/meta\.ts:\d+/, "search cites repo:path:line");
    assert.match(results[1], /export function setCondition/, "read_file returns real code");
    assert.ok(d!.artifacts.some((a) => a.spec.artifactTypeRef.name === "research-notes" && /meta\.ts/.test(a.spec.content)));

    // analysis agents only ever get read-only tools (+ finish)
    for (const [agent, tools] of Object.entries(toolSets)) {
      assert.deepEqual(tools.sort(), ["finish", "list_files", "read_file", "search_code"], agent);
    }
    assert.ok(toolSets["Triager"] && toolSets["Architect"] && toolSets["Reviewer"], JSON.stringify(Object.keys(toolSets)));
  } finally {
    await f.stop();
  }
});
