import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySandboxEnvironment } from "../adapters/sandbox/basic.ts";
import { Registry } from "../registry/registry.ts";
import type { AgentTool, ExecutionContext, TranscriptMessage } from "../ports/index.ts";
import { SANDBOX_TOOLS } from "./sandbox-tools.ts";
import { DefaultRecordedToolTurns } from "./recorded-tool-turns.ts";
import { ToolLoopExecutor } from "./tool-loop.ts";

test("recovery workflows reject workspace writes when no shared coordinator is wired", async () => {
  for (const recovery of [true, false]) {
    const environment = new InMemorySandboxEnvironment();
    const tools = new Registry<AgentTool>();
    for (const tool of SANDBOX_TOOLS) tools.register(tool.name, tool);
    const transcript: TranscriptMessage[] = [];
    let step = 0;
    const executor = new ToolLoopExecutor({
      reader: { get: async (kind: string) => kind === "Workflow" ? { spec: recovery ? { recovery: { version: "v1" } } : {} }
        : kind === "SandboxProfile" ? { metadata: { name: "sandbox" }, spec: { isolation: "container" } } : null } as never,
      prompts: { build: () => ({ system: "", user: "" }) }, tools,
      environments: { select: async () => ({ environment, health: await environment.health(), candidates: [] }), refresh: async () => {} },
      readers: { forWorkspaces: () => ({ readFile: async () => "", listFiles: async () => [], searchCode: async () => [] }) },
      turns: new DefaultRecordedToolTurns(),
    });
    const ctx = {
      run: { metadata: { name: "run" }, spec: { stage: "implement", tools: ["write_file"], outputs: [] } },
      agent: { metadata: { name: "developer" }, spec: { tools: ["write_file"], sandboxRef: { name: "sandbox" } } },
      workItem: { metadata: { namespace: "default" }, spec: { workflowRef: { name: "workflow" } } },
      repositories: [], workspaces: [{ spec: { repositoryRef: { name: "repo" } }, status: { baseCommit: "base" } }],
      model: { provider: "test", model: "test", tier: "reasoning", client: { completeWithTools: async () =>
        ({ toolCalls: ++step === 1 ? [{ id: "w", name: "write_file", arguments: { path: "file", content: "changed" } }]
          : [{ id: "f", name: "finish", arguments: { summary: "done" } }] }) } },
      transcript: { record: async (message: TranscriptMessage) => { transcript.push(message); } },
    } as unknown as ExecutionContext;
    await executor.execute(ctx);
    assert.equal(environment.sandboxes[0].files.has("file"), !recovery);
    const result = transcript.find((message) => message.role === "tool-result" && message.meta?.tool === "write_file");
    if (recovery) assert.match(result?.content ?? "", /requires shared workspace serialization/);
    else assert.match(result?.content ?? "", /wrote file/);
  }
});
