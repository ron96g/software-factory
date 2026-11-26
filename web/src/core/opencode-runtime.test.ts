import { proxyDispatcherActive } from "./adapters/http/proxy.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { OpenCodeExecutor, type OpenCodeExecutorDeps } from "./adapters/opencode/executor.ts";
import { OpenCodeHost } from "./adapters/opencode/host.ts";
import { HostEnvironment } from "./testing/host-environment.ts";
import { SANDBOX_TOOLS } from "./agents/sandbox-tools.ts";
import { Registry } from "./registry/registry.ts";
import {
  ModelUnavailableError,
  type AgentTool,
  type ExecutionContext,
  type ExecutionEnvironment,
  type FinishValidator,
  type ShellConfiner,
  type TranscriptMessage,
} from "./ports/index.ts";

/** One scripted model reply: a tool call, or text. */
type Reply = { tool: string; args: Record<string, unknown> } | { text: string } | { status: number; retryAfter?: string };
interface ModelRequest { tools: string[]; system: string; firstUser: string; toolResults: string[]; auth?: string; raw: string }

const root = mkdtempSync(join(tmpdir(), "factory-opencode-test-"));
const requests: ModelRequest[] = [];
let script: (req: ModelRequest) => Reply = () => ({ text: "done" });
let server: http.Server;
let url = "";
let host: OpenCodeHost;

const textOf = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const messages: { role: string; content: unknown }[] = body.messages ?? [];
      const parsed: ModelRequest = {
        tools: (body.tools ?? []).map((t: { function?: { name: string } }) => t.function?.name),
        system: messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n"),
        firstUser: textOf(messages.find((m) => m.role === "user")?.content ?? ""),
        toolResults: messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)),
        auth: req.headers.authorization,
        raw,
      };
      if (!parsed.tools.length) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
        return;
      }
      requests.push(parsed);
      const reply = script(parsed);
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}) })
          .end(JSON.stringify({ error: { message: "quota exhausted" } }));
        return;
      }
      const delta = "tool" in reply
        ? { tool_calls: [{ index: 0, id: `call_${requests.length}_${reply.tool}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
        : { content: reply.text };
      const chunk = (d: unknown, finish: string | null) =>
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      chunk({ role: "assistant", ...delta }, null);
      chunk({}, "tool" in reply ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = new OpenCodeHost({ dataDir: join(root, "state"), log: () => {} });
});

after(async () => {
  await host.close();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

/** A Git workspace inside a directory that has its own AGENTS.md and skill, which must never leak in. */
function workspace(name: string) {
  const outer = join(root, name);
  const path = join(outer, "item", "repo");
  mkdirSync(join(outer, ".agents", "skills", "outer-skill"), { recursive: true });
  writeFileSync(join(outer, "AGENTS.md"), "OUTER_INSTRUCTIONS_MARKER\n");
  writeFileSync(join(outer, ".agents", "skills", "outer-skill", "SKILL.md"), "---\nname: outer-skill\ndescription: must not leak\n---\nouter\n");
  mkdirSync(join(path, ".agents", "skills", "repo-build"), { recursive: true });
  writeFileSync(join(path, "AGENTS.md"), "REPO_INSTRUCTIONS_MARKER: build with make\n");
  writeFileSync(join(path, ".agents", "skills", "repo-build", "SKILL.md"), "---\nname: repo-build\ndescription: How to build this repository\n---\nRun make build.\n");
  writeFileSync(join(path, "README.md"), "hello\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=f@f", "-c", "user.name=f", "commit", "-qm", "init");
  return { path, baseCommit: git("rev-parse", "HEAD") };
}

function setup(o: {
  tools: string[];
  extraTools?: AgentTool[];
  sandbox?: boolean;
  environment?: ExecutionEnvironment & Partial<ShellConfiner>;
  sandboxHealth?: { runtime: string; available: boolean; isolation: "none" | "process" | "container" | "microvm"; confinesShell?: boolean };
  outputs?: string[];
  finish?: FinishValidator;
  maxSteps?: number;
}) {
  const ws = workspace(`ws-${Math.random().toString(36).slice(2, 8)}`);
  const transcript: TranscriptMessage[] = [];
  const mutations: string[] = [];
  const tools = new Registry<AgentTool>();
  for (const t of [...SANDBOX_TOOLS, ...(o.extraTools ?? [])]) tools.register(t.name, t);
  const environment = o.environment ?? new HostEnvironment();
  const deps: OpenCodeExecutorDeps = {
    host,
    reader: { get: async (kind: string) => (kind === "SandboxProfile" ? { metadata: { name: "node-build" }, spec: { image: "", isolation: "process", acceptWeakerIsolation: true, env: { GOPROXY: "off" } } } : null),
      list: async () => [] } as never,
    prompts: { build: () => ({ system: "FACTORY_AGENT_SYSTEM", user: "Implement the unit." }) },
    tools,
    environments: { select: async () => ({ environment, health: o.sandboxHealth ?? await environment.health(), candidates: [] }), refresh: async () => {} },
    readers: { forWorkspaces: () => ({ readFile: async () => "", listFiles: async () => [], searchCode: async () => [] }) },
    scratchDir: join(root, "scratch"),
    jobs: { mutate: async (_ctx, op) => { mutations.push("mutate"); return op(); }, submit: async (_item, op) => op() },
    finish: o.finish,
    maxSteps: o.maxSteps,
  };
  const ctx = {
    run: { metadata: { name: `run-${Math.random().toString(36).slice(2, 8)}`, namespace: "default" }, spec: { stage: "implement", step: "develop", outputs: (o.outputs ?? []).map((name) => ({ name })) } },
    agent: { metadata: { name: "developer", namespace: "factory-system" }, spec: { tools: o.tools, ...(o.sandbox ? { sandboxRef: { name: "node-build" } } : {}) } },
    model: { provider: "fake", providerType: "openai-compatible", model: "coding-model", tier: "coding", client: { complete: async () => "" },
      endpoint: { type: "openai-compatible", baseUrl: url, apiKey: "sk-factory-test-key-0042" } },
    workItem: { metadata: { name: "item", namespace: "default" }, spec: {} },
    workspaces: [{ metadata: { name: "item-repo" }, spec: { repositoryRef: { name: "repo" }, workItemRef: { name: "item" } }, status: { phase: "Ready", path: ws.path, baseCommit: ws.baseCommit } }],
    repositories: [], inputs: [], sections: [], clarifications: [], approvals: [], skills: [],
    sandbox: o.sandbox ? (o.sandboxHealth ?? { runtime: "host", available: true, isolation: "none", confinesShell: true }) : undefined,
    transcript: { ref: { namespace: "default", id: "t" }, record: async (m: TranscriptMessage) => { transcript.push(m); } },
  } as unknown as ExecutionContext;
  return { executor: new OpenCodeExecutor(deps), ctx, transcript, mutations, ws };
}

const main = (req: ModelRequest) => !req.firstUser.includes("CHILD_TASK");

test("ADR-0060: the developer edits, runs commands and corrects finish in one recorded OpenCode session", async () => {
  process.env.FACTORY_TEST_SECRET = "factory-secret-value";
  const finish: FinishValidator = { validate: async (_ctx, result) => (result.summary === "first try" ? ["summary must name the changed file"] : []) };
  const s = setup({ tools: ["read_file", "write_file", "run"], sandbox: true, outputs: ["source-code"], finish });
  requests.length = 0;
  script = (req) => [
    { tool: "skill", args: { id: "repo-build" } },
    { tool: "write", args: { path: "src/feature.txt", content: "implemented\n" } },
    { tool: "shell", args: { command: "echo secret=$FACTORY_TEST_SECRET proxy=$GOPROXY && cat src/feature.txt", description: "check" } },
    { tool: "finish", args: { summary: "first try" } },
    { tool: "finish", args: { summary: "added src/feature.txt", artifacts: [{ type: "source-code", content: "# Feature" }] } },
  ][req.toolResults.length] ?? { text: "done" };

  assert.equal(s.executor.canExecute(s.ctx), true);
  const result = await s.executor.execute(s.ctx);
  assert.equal(result.summary, "added src/feature.txt");
  assert.equal(readFileSync(join(s.ws.path, "src/feature.txt"), "utf8"), "implemented\n");
  assert.match(result.artifacts?.[0].content ?? "", /# Feature[\s\S]*\+implemented/, "the workspace diff is attached to source-code");
  assert.equal(result.provenance?.toolUse?.finishCorrections, 1);
  assert.match(String(result.provenance?.model?.params?.runtime), /^opencode/);
  assert.equal(s.mutations.length, 2, "write and shell are serialized with workspace jobs");

  const first = requests[0];
  assert.equal(first.auth, "Bearer sk-factory-test-key-0042", "the factory's provider and key serve the model call");
  assert.match(first.system, /FACTORY_AGENT_SYSTEM/);
  assert.match(first.system, /REPO_INSTRUCTIONS_MARKER/, "the repository's AGENTS.md reaches the agent");
  assert.doesNotMatch(first.raw, /OUTER_INSTRUCTIONS_MARKER|outer-skill/, "nothing from outside the workspace leaks in");
  assert.match(requests[1].toolResults[0], /Run make build/, "the repository skill loads");
  assert.deepEqual(first.tools.sort(), ["edit", "execute", "finish", "glob", "grep", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write"]);

  const shell = s.transcript.find((m) => m.role === "tool-result" && m.meta?.tool === "shell");
  assert.match(shell?.content ?? "", /secret= proxy=off/, "commands get the profile env and never factory secrets");
  assert.match(s.transcript.find((m) => m.role === "tool-result" && m.meta?.tool === "finish")?.content ?? "", /finish rejected \(correction 1 of 2\)/);
  assert.ok(s.transcript.some((m) => m.role === "note" && /^Model request: fake\/coding-model/.test(m.content)));
  assert.ok(s.transcript.some((m) => m.role === "note" && m.meta?.usage), "provider usage is recorded per step");
  assert.ok(s.transcript.some((m) => m.role === "tool-call" && m.meta?.tool === "write"));
  assert.doesNotMatch(JSON.stringify(s.transcript), /sk-factory-test-key-0042/);
  delete process.env.FACTORY_TEST_SECRET;
});

test("ADR-0060: read-only agents cannot write or leave the workspace; sub-agents inherit that and are recorded", async () => {
  const s = setup({ tools: ["read_file", "search_code"] });
  requests.length = 0;
  script = (req) => main(req)
    ? [
      { tool: "write", args: { path: "x.txt", content: "x" } },
      { tool: "read", args: { path: "/etc/hostname" } },
      { tool: "subagent", args: { agent: "explore", description: "find docs", prompt: "CHILD_TASK: try to write" } },
      { tool: "finish", args: { summary: "reviewed" } },
    ][req.toolResults.length] ?? { text: "done" }
    : req.toolResults.length === 0 ? { tool: "edit", args: { path: "README.md", oldString: "hello", newString: "bye" } } : { text: "child done" };

  const result = await s.executor.execute(s.ctx);
  assert.equal(result.summary, "reviewed");
  assert.deepEqual(requests[0].tools.sort(), ["execute", "finish", "glob", "grep", "read", "skill", "subagent", "webfetch", "websearch"]);
  const child = requests.find((r) => !main(r));
  assert.ok(child, "the sub-agent ran");
  assert.ok(!child.tools.includes("subagent") && !child.tools.includes("finish") && !child.tools.includes("edit"));
  assert.equal(readFileSync(join(s.ws.path, "README.md"), "utf8"), "hello\n");
  const results = s.transcript.filter((m) => m.role === "tool-result").map((m) => `${m.meta?.tool}: ${m.content}`);
  assert.ok(results.some((r) => /^write: error: .*not available/.test(r)), results.join("\n"));
  assert.ok(results.some((r) => /^read: error:/.test(r)), results.join("\n"));
  assert.ok(s.transcript.some((m) => m.meta?.subagentSession && m.role === "tool-call" && m.meta.tool === "edit"), "sub-agent calls are recorded");
  assert.equal(s.mutations.length, 0);
});

test("ADR-0060: only the workspace's own skills load, and runs that cannot read get no sub-agents", async () => {
  const s = setup({ tools: ["read_file"] });
  script = (req) => [
    { tool: "skill", args: { id: "browser" } },
    { tool: "skill", args: { id: "outer-skill" } },
    { tool: "finish", args: { summary: "ok" } },
  ][req.toolResults.length] ?? { text: "done" };
  const result = await s.executor.execute(s.ctx);
  assert.match(String(result.provenance?.model?.params?.runtime), /^opencode@\d+\.\d+\.\d+$/);
  const rejected = s.transcript.filter((m) => m.role === "tool-result" && m.meta?.tool === "skill").map((m) => m.content);
  assert.equal(rejected.length, 2);
  for (const r of rejected) assert.match(r, /is not available; skills in this workspace: repo-build/);

  const blind = setup({ tools: [] });
  requests.length = 0;
  script = () => ({ tool: "finish", args: { summary: "no code access" } });
  await blind.executor.execute(blind.ctx);
  assert.deepEqual(requests[0].tools.sort(), ["execute", "finish", "skill", "webfetch", "websearch"]);
});

test("ADR-0060: the last step offers only finish, and a run that never finishes fails", async () => {
  const s = setup({ tools: ["read_file"], maxSteps: 2 });
  requests.length = 0;
  script = () => ({ tool: "read", args: { path: "README.md" } });
  await assert.rejects(s.executor.execute(s.ctx), /did not finish within 2 steps/);
  assert.deepEqual(requests[1].tools, ["finish"]);
  assert.ok(s.transcript.some((m) => m.role === "note" && /Last model step \(budget 2\)/.test(m.content)));
});

test("ADR-0060: an exhausted quota makes the run wait with the provider's delay instead of failing", async () => {
  const s = setup({ tools: ["read_file"] });
  script = () => ({ status: 429, retryAfter: "42" });
  const error = await s.executor.execute(s.ctx).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof ModelUnavailableError, String(error));
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 42_000);
});

test("ADR-0060: a provider retry of the same request does not use up a step", async () => {
  const s = setup({ tools: ["read_file"] });
  let calls = 0;
  script = () => (++calls === 1 ? { status: 500 } : { tool: "finish", args: { summary: "after retry" } });
  const result = await s.executor.execute(s.ctx);
  assert.equal(result.summary, "after retry");
  assert.equal(calls, 2);
  assert.equal(result.provenance?.toolUse?.steps, 1);
  assert.equal(s.transcript.filter((m) => m.role === "note" && m.content.startsWith("Model request:")).length, 1);
  assert.ok(s.transcript.some((m) => m.role === "note" && m.content.startsWith("provider retry scheduled")));
});

test("ADR-0060: loading OpenCode keeps the factory's proxy dispatcher (proxy settings keep working)", () => {
  assert.equal(proxyDispatcherActive({ HTTPS_PROXY: "http://proxy.invalid:8080" }), true);
});

test("ADR-0060: unsupported providers and isolated sandboxes fall back to other executors", () => {
  const s = setup({ tools: ["read_file", "write_file"], sandbox: true });
  assert.equal(s.executor.canExecute({ ...s.ctx, sandbox: { runtime: "podman", available: true, isolation: "container" } }), false);
  assert.equal(s.executor.canExecute({ ...s.ctx, sandbox: { runtime: "bwrap", available: true, isolation: "process", confinesShell: true } }), true);
  assert.equal(s.executor.canExecute({ ...s.ctx, model: { ...s.ctx.model!, endpoint: { type: "unknown" } } }), false);
  assert.equal(s.executor.canExecute({ ...s.ctx, agent: { ...s.ctx.agent, spec: { ...s.ctx.agent.spec, tools: ["kubectl"] } } }), false);
});

test("ADR-0078: Code Mode invokes factory tools, strips opencode_*/browser_*, and keeps finish direct", async () => {
  const calls: string[] = [];
  const lookupTool: AgentTool = {
    name: "factory_lookup",
    description: "Look up a factory record",
    readOnly: true,
    capabilities: [],
    bind: () => ({
      schema: { name: "factory_lookup", description: "Look up a factory record", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      invoke: async (args) => {
        const key = String(args.key ?? "");
        calls.push(key);
        return `found:${key}`;
      },
    }),
  };
  const s = setup({ tools: ["read_file", "factory_lookup"], extraTools: [lookupTool] });
  requests.length = 0;
  script = (req) => [
    {
      tool: "execute",
      args: {
        code: [
          `const a = await tools.factory_lookup({ key: "alpha" });`,
          `const b = await tools.factory_lookup({ key: "beta" });`,
          `const opencodeTools = search({ namespace: "opencode" }).items.map((i) => i.path);`,
          `const browserTools = search({ namespace: "browser" }).items.map((i) => i.path);`,
          `return { a, b, opencodeTools, browserTools };`,
        ].join("\n"),
      },
    },
    { tool: "finish", args: { summary: "composed via code mode" } },
  ][req.toolResults.length] ?? { text: "done" };

  const result = await s.executor.execute(s.ctx);
  assert.equal(result.summary, "composed via code mode");
  assert.ok(requests[0].tools.includes("execute"));
  assert.ok(requests[0].tools.includes("finish"));
  assert.ok(!requests[0].tools.includes("factory_lookup"), "factory tools run inside Code Mode instead of cluttering direct tools");
  assert.deepEqual(calls, ["alpha", "beta"]);
  const execResult = s.transcript.find((m) => m.role === "tool-result" && m.meta?.tool === "execute");
  assert.match(execResult?.content ?? "", /found:alpha/);
  assert.match(execResult?.content ?? "", /found:beta/);
  assert.match(execResult?.content ?? "", /"opencodeTools":\[\]/);
  assert.match(execResult?.content ?? "", /"browserTools":\[\]/);
  assert.equal(result.provenance?.toolUse?.calls?.execute, 1);
  assert.equal(result.provenance?.toolUse?.calls?.factory_lookup, 2, "nested Code Mode tool calls are counted in provenance");
  assert.equal(s.transcript.filter((m) => m.role === "tool-call" && m.meta?.tool === "factory_lookup").length, 2, "nested Code Mode tool calls are recorded");
});

test("ADR-0079: process-isolated ShellConfiner runtime wraps OpenCode shell commands", async () => {
  const confinedCalls: Array<{ workspace: string; cwd: string; command: string }> = [];
  const baseEnv = new HostEnvironment();
  const fakeBwrap: ExecutionEnvironment & ShellConfiner = {
    runtime: "bwrap",
    health: async () => ({ runtime: "bwrap", available: true, isolation: "process", confinesShell: true }),
    prepare: (spec) => baseEnv.prepare(spec),
    confineShell: (input) => {
      confinedCalls.push({ workspace: input.workspace, cwd: input.cwd, command: input.command });
      return { command: `echo CONFINED=yes && ${input.command}`, env: { ...input.env, HOME: "/tmp/home" } };
    },
  };
  const s = setup({
    tools: ["read_file", "run"],
    sandbox: true,
    environment: fakeBwrap,
    sandboxHealth: { runtime: "bwrap", available: true, isolation: "process", confinesShell: true },
  });
  requests.length = 0;
  script = (req) => [
    { tool: "shell", args: { command: "echo home=$HOME", description: "check confined shell" } },
    { tool: "finish", args: { summary: "confined shell verified" } },
  ][req.toolResults.length] ?? { text: "done" };

  assert.equal(s.executor.canExecute(s.ctx), true);
  const result = await s.executor.execute(s.ctx);
  assert.equal(result.summary, "confined shell verified");
  assert.equal(confinedCalls.length, 1);
  assert.equal(confinedCalls[0].workspace, s.ws.path);
  const shellResult = s.transcript.find((m) => m.role === "tool-result" && m.meta?.tool === "shell");
  assert.match(shellResult?.content ?? "", /CONFINED=yes/);
  assert.match(shellResult?.content ?? "", /home=\/tmp\/home/);
});
