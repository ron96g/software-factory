import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ExecutionContext, RuntimeModelAccess } from "./ports/index.ts";
import type { SandboxProfile } from "./model/kinds.ts";
import { Registry } from "./registry/registry.ts";
import { BwrapAgentRuntime } from "./adapters/runtime/bwrap.ts";
import { GitBundleIngest, GitCandidateDiffer } from "./adapters/workspaces/git-export.ts";
import { AgentRuntimeExecutor } from "./agents/agent-runtime-executor.ts";
import { createRunControlServerFactory } from "./adapters/runtime/control.ts";

const RUNNER = join(import.meta.dirname, "../agent-runtime/runner.ts");

function gitRepo(): { path: string; commit: string } {
  const path = mkdtempSync(join(tmpdir(), "sf-e2e-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "a.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: path });
  return { path, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path }).toString().trim() };
}

test("S2-b: a run completes through the AgentRuntimeExecutor, with the loop, tools and proxy inside bwrap", async (t) => {
  const runtime = new BwrapAgentRuntime({ root: mkdtempSync(join(tmpdir(), "sf-e2e-root-")), runnerPath: RUNNER });
  if (!(await runtime.health()).available) { t.skip("bwrap unavailable"); return; }

  let knowledgeCalls = 0;
  const searchKnowledge: AgentTool = { name: "search_knowledge", readOnly: true, description: "search knowledge", capabilities: ["knowledge"],
    bind: () => ({ schema: { name: "search_knowledge", description: "search knowledge", parameters: {} }, invoke: async () => { knowledgeCalls++; return "knowledge hit: use the strategy pattern"; } }) };
  const readFile: AgentTool = { name: "read_file", readOnly: true, description: "read a file", capabilities: ["read"],
    bind: () => ({ schema: { name: "read_file", description: "read a file", parameters: {} }, invoke: async () => "file contents" }) };
  const tools = new Registry<AgentTool>();
  for (const tool of [searchKnowledge, readFile]) tools.register(tool.name, tool);

  let sawModelAuth = "";
  let modelCalls = 0;
  const proxy = async (req: Request): Promise<Response> => {
    sawModelAuth = req.headers.get("authorization") ?? "";
    modelCalls++;
    const toolCall = (name: string, args: unknown) => ({ id: `c${modelCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (modelCalls === 1) return Response.json({ choices: [{ message: { content: "looking it up", tool_calls: [toolCall("search_knowledge", { query: "design" })] } }] });
    if (modelCalls === 2) return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall("write_file", { path: "b.txt", content: "hello from the runtime\n" })] } }] });
    return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall("finish", { summary: "implemented the spec", artifacts: [{ type: "spec", content: "# Spec" }] })] } }] });
  };

  const issued: string[] = [];
  const revoked: string[] = [];
  const modelAccess: RuntimeModelAccess = {
    issue: async () => { issued.push("sfm_e2e"); return { baseUrl: "", token: "sfm_e2e" }; },
    revoke: async () => { revoked.push("sfm_e2e"); return 1; },
  };

  const seed = gitRepo();
  const ex = new AgentRuntimeExecutor({
    runtime,
    reader: { get: async (kind: string) => (kind === "SandboxProfile" ? { metadata: { name: "node-build", namespace: "factory-system" }, spec: { isolation: "process", acceptWeakerIsolation: true, network: { mode: "none" } } } as unknown as SandboxProfile : null), list: async () => [] } as never,
    prompts: { build: () => ({ system: "SYSTEM", user: "implement the spec" }) },
    tools,
    modelAccess,
    export: new GitBundleIngest(),
    diff: new GitCandidateDiffer(),
    mirrorsDir: mkdtempSync(join(tmpdir(), "sf-e2e-mirrors-")),
    capabilities: () => ({ read: { readFile: async () => "", listFiles: async () => [] }, knowledge: { search: async () => [] } as never }),
    controlServer: createRunControlServerFactory({ proxy }),
  });

  const transcript: { role: string; content: string; meta?: Record<string, unknown> }[] = [];
  const ctx = {
    run: { metadata: { name: "run-e2e", namespace: "default", uid: "u1" }, spec: { stage: "implement", step: "develop", outputs: [{ name: "spec" }, { name: "source-code" }] } },
    agent: { metadata: { name: "developer", namespace: "factory-system" }, spec: { tools: ["search_knowledge", "read_file"], sandboxRef: { name: "node-build" } } },
    skills: [], workItem: { metadata: { name: "item", namespace: "default" }, spec: {} },
    model: { provider: "copilot", providerType: "openai-compatible", model: "gpt-x", tier: "coding", client: {}, endpoint: { type: "openai-compatible" } },
    workspaces: [{ metadata: { name: "item-repo" }, spec: { repositoryRef: { name: "repo" } }, status: { phase: "Ready", path: seed.path, baseCommit: seed.commit } }],
    repositories: [], inputs: [], clarifications: [], approvals: [], sections: [],
    transcript: { ref: { namespace: "default", id: "t" }, record: async (m: { role: string; content: string; meta?: Record<string, unknown> }) => { transcript.push(m); } },
  } as unknown as ExecutionContext;

  assert.equal(ex.canExecute(ctx), true);
  const result = await ex.execute(ctx);

  assert.equal(result.summary, "implemented the spec");
  const spec = result.artifacts?.find((a) => a.type === "spec");
  assert.deepEqual(spec, { type: "spec", content: "# Spec" });
  const sourceCode = result.artifacts?.find((a) => a.type === "source-code");
  assert.match(sourceCode?.content ?? "", /b\.txt/);
  assert.match(sourceCode?.content ?? "", /hello from the runtime/, "the source-code artifact carries the diff from the ingested commit (ADR-0080 §13)");
  assert.equal(result.provenance?.runtime?.backend, "bwrap");
  assert.match(result.provenance?.runtime?.exportedCommit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(knowledgeCalls, 1, "the factory-side tool ran on the surface, inside the run");
  assert.equal(sawModelAuth, "Bearer sfm_e2e", "the model proxy was reached with the run token, never a provider key");
  assert.ok(transcript.some((m) => m.meta?.runtimeReported === true), "runtime events recorded as reported");
  assert.equal(issued.length, 1);
  assert.equal(revoked.length, 1);
});
