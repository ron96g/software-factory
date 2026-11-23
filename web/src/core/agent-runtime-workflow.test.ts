import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { testDefinitions } from "./testing/definitions.ts";
import { BwrapAgentRuntime } from "./adapters/runtime/bwrap.ts";
import { ANONYMOUS, type DefinitionLoader, type PreparedWorkspace } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Node-build ships `network: allowlist`; bwrap provides `none`, so the test supplies a no-egress profile (ADR-0080 §7). */
function noEgressDefinitions(): DefinitionLoader {
  const base = testDefinitions();
  return {
    async load() {
      return (await base.load()).map((r) => (r.kind === "SandboxProfile" ? { ...r, spec: { ...(r.spec as Record<string, unknown>), network: { mode: "none" } } } : r));
    },
  };
}

/**
 * A fake provider. The developer runs **inside the AgentRuntime**, so its model calls arrive here through the proxy
 * with the run's tool offering. Any request that carries tools is a tool loop (in-process or in the runtime) and gets
 * a `finish` tool call; a request without tools is JSON mode (the LLM executor).
 */
function fakeLLM() {
  let devCalls = 0;
  const toolCall = (name: string, args: unknown, id = "f") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content?: string }[]; tools?: { name?: string; function?: { name?: string } }[] };
    // The runtime sends plain tool schemas; the in-process loop sends OpenAI-shaped tools. Accept both.
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "");
    const system = String(body.messages[0]?.content ?? "");
    if (tools.length) {
      const finish = (args: unknown) => Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall("finish", args)] } }] });
      if (tools.includes("write_file")) {
        devCalls++;
        return devCalls === 1
          ? Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall("write_file", { path: "feature.txt", content: "implemented\n" }, `d${devCalls}`)] } }] })
          : finish({ summary: "implemented the Unit", outcome: "complete", artifacts: [{ type: "source-code", content: "# Changes" }] });
      }
      if (system.includes("## Skill: code-review")) return finish({ summary: "LGTM", outcome: "approve", artifacts: [{ type: "code-review-report", content: "No blocking findings." }] });
      return finish({ summary: "ok", outcome: "accept", artifacts: [] });
    }
    const out = { summary: "ok", outcome: "accept", questions: [], artifacts: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }) as typeof fetch;
}

function gitRepo(): { path: string; commit: string } {
  const path = mkdtempSync(join(tmpdir(), "sf-wf-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: path });
  g("init", "-q", "-b", "main");
  writeFileSync(join(path, "a.txt"), "one\n");
  g("add", ".");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: path });
  return { path, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path }).toString().trim() };
}

async function drive(f: Factory, name: string, until: (d: NonNullable<Awaited<ReturnType<Factory["app"]["getWorkItem"]>>>) => boolean) {
  for (let i = 0; i < 2000; i++) {
    const d = (await f.app.getWorkItem(p, name))!;
    if (until(d)) return d;
    const st = d.workItem.status;
    if (st?.phase === "AwaitingApproval" && st.stage === "spec-review") {
      const open = d.approvals.find((a) => !a.spec.decision);
      if (open) await f.app.decideApproval(p, open.metadata.name, "approve");
    } else if (st?.phase === "Failed") assert.fail(st.message);
    await sleep(15);
  }
  const d = (await f.app.getWorkItem(p, name))!;
  throw new Error(`timeout: ${JSON.stringify(d.workItem.status)} events=${d.events.slice(-6).map((e) => `${e.spec.reason}:${e.spec.message.slice(0, 100)}`).join(" | ")}`);
}

test("S2: a real item's developer step completes end to end with the loop inside bwrap", async (t) => {
  const runtime = new BwrapAgentRuntime({ root: mkdtempSync(join(tmpdir(), "sf-wf-rt-")), runnerPath: join(import.meta.dirname, "../agent-runtime/runner.ts") });
  if (!(await runtime.health()).available) { t.skip("bwrap unavailable"); return; }

  const repo = gitRepo();
  const backend = {
    supports: () => true,
    sweep: async () => [],
    remove: async () => {},
    prepare: async (): Promise<PreparedWorkspace> => ({ path: repo.path, baseCommit: repo.commit, headCommit: repo.commit, preparedBy: "fake", setupCompleted: true }),
  };
  const f = await createFactory({
    definitionsRoot: ROOT,
    definitionLoader: noEgressDefinitions(),
    databasePath: ":memory:",
    env: { FACTORY_AGENT_RUNTIME: "tool-loop", FACTORY_SANDBOX_RUNTIME: "none", FACTORY_AGENT_RUNTIME_BACKEND: "bwrap", OPENAI_API_KEY: "sk-test-123456" },
    agentRuntimes: [runtime],
    workspaceBackend: backend,
    fetch: fakeLLM(),
    log: () => {},
  });
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Runtime item", description: "A long enough description for triage to accept it directly.", workflowRef: "test-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.runs.some((r) => r.spec.step === "write-code" && r.status?.phase === "Succeeded"));

    const dev = d.runs.find((r) => r.spec.step === "write-code" && r.status?.phase === "Succeeded")!;
    assert.equal(dev.status?.provenance?.runtime?.backend, "bwrap", "the developer step ran on the AgentRuntime");
    assert.match(dev.status?.provenance?.runtime?.exportedCommit ?? "", /^[0-9a-f]{40}$/);
    const source = d.artifacts.find((a) => a.spec.artifactTypeRef.name === "source-code" && a.spec.producedBy?.agentRunRef.name === dev.metadata.name);
    assert.ok(source, "the source-code artifact came from the runtime's exported commit");
    assert.match(source!.spec.content, /feature\.txt/, "the artifact carries the diff read from the bare mirror (ADR-0080 §13)");
  } finally {
    await f.stop();
  }
});
