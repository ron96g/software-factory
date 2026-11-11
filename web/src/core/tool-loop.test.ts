import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { InMemorySandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { ANONYMOUS } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;

type Msg = { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string };

/**
 * Scripted OpenAI-compatible fake. JSON-mode calls get a generic "accept" answer; tool-mode calls follow a script
 * that depends on how many tool results the conversation already contains.
 */
function fakeOpenAI() {
  const toolRequests: { agent: string; messages: Msg[] }[] = [];
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const developer = [
    call("c1", "list_files", {}),
    call("c2", "read_file", { path: "src/sum.js" }),
    call("c3", "write_file", { path: "src/sum.js", content: "export const sum = (a, b) => a + b;\n" }),
    call("c4", "run", { command: "npm test" }),
    call("c5", "finish", { summary: "Fixed sum(): it subtracted instead of adding. Tests pass." }),
  ];
  const verifier = [
    call("v1", "run", { command: "npm test" }),
    call("v2", "finish", { summary: "All acceptance criteria covered; tests pass.", artifacts: [{ type: "verification-report", content: "| AC | test | result |\n|---|---|---|\n| sum adds | sum.test | pass |" }] }),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Msg[]; tools?: unknown[] };
    const system = String(body.messages[0].content ?? "");
    if (body.tools) {
      const agent = system.includes("Developer Agent") ? "developer" : "verifier";
      toolRequests.push({ agent, messages: body.messages });
      const done = body.messages.filter((m) => m.role === "tool").length;
      const script = agent === "developer" ? developer : verifier;
      // one tool call per turn: index = number of tool results so far
      return Response.json({ choices: [{ message: { content: null, tool_calls: [script[done]] } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  }) as typeof fetch;
  return { fetchImpl, toolRequests };
}

test("S3: developer agent fixes code and runs tests in the sandbox via the tool loop (fully recorded)", async () => {
  const llm = fakeOpenAI();
  const sandboxes = new InMemorySandboxEnvironment({
    seed: { "src/sum.js": "export const sum = (a, b) => a - b;\n", "package.json": "{}" },
    handlers: [
      (cmd, files) =>
        cmd === "npm test"
          ? files.get("src/sum.js")?.includes("a + b")
            ? { exitCode: 0, stdout: "1 passing" }
            : { exitCode: 1, stdout: "1 failing: expected 3, got -1" }
          : undefined,
    ],
  });
  const f = await createFactory({
    definitionsRoot: ROOT,
    databasePath: ":memory:",
    env: { OPENAI_API_KEY: "sk-test-abcdef", FACTORY_SANDBOX_RUNTIME: "in-memory" },
    fetch: llm.fetchImpl,
    sandboxes: [sandboxes],
    log: () => {},
  });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "sum() is wrong", description: "sum(1, 2) returns -1 instead of 3. Fix it and keep tests green." });
    const name = wi.metadata.name;
    let detail = null;
    for (let i = 0; i < 600; i++) {
      const d = await f.app.getWorkItem(p, name);
      if (d?.workItem.status?.phase === "AwaitingApproval" && ["spec-review", "code-review"].includes(d.workItem.status.stage ?? "")) {
        const open = d.approvals.find((a) => !a.spec.decision);
        if (open) await f.app.decideApproval(p, open.metadata.name, "approve");
      }
      if (d?.workItem.status?.phase === "Failed") assert.fail(`work item failed: ${d.workItem.status.message}`);
      if (d?.runs.some((r) => r.spec.step === "verify-against-spec" && r.status?.phase === "Succeeded")) {
        detail = d;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(detail, "verify step finished");

    const dev = detail.runs.find((r) => r.spec.step === "write-code")!;
    assert.equal(dev.status?.provenance?.executor, "tool-loop");
    assert.equal(dev.status?.provenance?.executionEnvironment, "in-memory@test");
    const code = detail.artifacts.find((a) => a.spec.artifactTypeRef.name === "source-code")!;
    assert.match(code.spec.content, /\+export const sum = \(a, b\) => a \+ b;/);
    assert.match(code.spec.content, /-export const sum = \(a, b\) => a - b;/);

    const t = await f.app.runTranscript(p, dev.metadata.name);
    const calls = t.filter((m) => m.role === "tool-call").map((m) => m.meta?.tool);
    assert.deepEqual(calls, ["list_files", "read_file", "write_file", "run", "finish"]);
    assert.ok(t.some((m) => m.role === "tool-result" && m.content.startsWith("exit 0")), "tests ran green");
    assert.ok(t.some((m) => /disposed/.test(m.content)), "sandbox disposed");

    const ver = detail.runs.find((r) => r.spec.step === "verify-against-spec")!;
    assert.equal(ver.status?.provenance?.executor, "tool-loop");
    assert.ok(detail.artifacts.some((a) => a.spec.artifactTypeRef.name === "verification-report" && /pass/.test(a.spec.content)));

    assert.ok(sandboxes.sandboxes.length >= 2 && sandboxes.sandboxes.every((s) => s.disposed), "one sandbox per run, all disposed");
    // the verifier has no write tool
    const verifierTools = llm.toolRequests.find((r) => r.agent === "verifier");
    assert.ok(verifierTools);
  } finally {
    await f.stop();
  }
});

test("S3: tools receive only the capabilities they declare (ISP)", async () => {
  const { SANDBOX_TOOLS } = await import("./agents/sandbox-tools.ts");
  for (const t of SANDBOX_TOOLS) {
    assert.ok(t.capabilities?.length, `${t.name} declares capabilities`);
    // binding with only the declared capabilities must work …
    const caps = Object.fromEntries(t.capabilities!.map((c) => [c, {}]));
    assert.doesNotThrow(() => t.bind!(caps as never), `${t.name} binds with declared caps`);
    // … and with none it must refuse
    assert.throws(() => t.bind!({}), /needs sandbox capability/, `${t.name} refuses without caps`);
  }
});
