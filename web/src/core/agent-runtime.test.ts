import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentTool,
  ExecutionContext,
  ExportIngestor,
  RuntimeModelAccess,
} from "./ports/index.ts";
import type { Ref } from "./model/resource.ts";
import { ANONYMOUS, ModelUnavailableError, RuntimeRefusedError } from "./ports/index.ts";
import { Registry } from "./registry/registry.ts";
import { AgentRuntimeExecutor } from "./agents/agent-runtime-executor.ts";
import { createRunControlServerFactory } from "./adapters/runtime/control.ts";
import { FakeAgentRuntime } from "./testing/fake-agent-runtime.ts";
import { createFactory } from "./factory.ts";
import { testDefinitions } from "./testing/definitions.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

// ── Port contract: the fake runtime satisfies `AgentRuntime` (S2-a) ────────────────────────────────────────────

test("S2-a contract: an AgentRuntime is created per run, idempotent, and reports capabilities/health", async () => {
  const runtime = new FakeAgentRuntime({ isolation: "process", network: ["none"] });
  assert.equal(runtime.backend, "fake");
  assert.deepEqual((await runtime.capabilities()).network, ["none"]);
  assert.equal((await runtime.health()).available, true);

  const spec = jobSpec();
  const secrets = { modelToken: "sfm_m", toolToken: "sfm_t" };
  const a = await runtime.create(spec, secrets);
  const b = await runtime.create(spec, secrets); // idempotent per run (rule 6)
  assert.equal(a.id, b.id);
  assert.deepEqual(runtime.lastSecrets, secrets, "the runtime receives the run secrets out of band");
  assert.equal((await a.wait()).status, "succeeded");
  assert.deepEqual(await a.events(), []);
  assert.match((await a.export()).bundlePath, /out\.bundle$/);
  await a.dispose();
});

test("S2-a contract: create refuses a network mode the backend cannot enforce (ADR-0080 §7)", async () => {
  const runtime = new FakeAgentRuntime({ network: ["none"] });
  await assert.rejects(runtime.create(jobSpec({ network: "allowlist" }), { modelToken: "m", toolToken: "t" }), (e: unknown) => {
    assert.ok(e instanceof RuntimeRefusedError);
    assert.equal(e.reason, "network");
    return true;
  });
});

// ── The factory-side executor: no provider key, finish validated, token revoked, events recorded ──────────────

const TOOL: AgentTool = { name: "read_file", readOnly: true, description: "read", capabilities: ["read"], bind: () => ({ schema: { name: "read_file", description: "read", parameters: {} }, invoke: async () => "" }) };

const PROFILE = (network?: "none" | "allowlist") => ({
  metadata: { name: "node-build", namespace: "factory-system" },
  spec: { image: "", isolation: "process", acceptWeakerIsolation: true, network: network ? { mode: network } : undefined },
});

function context(): { ctx: ExecutionContext; transcript: { role: string; content: string; meta?: Record<string, unknown> }[] } {
  const transcript: { role: string; content: string; meta?: Record<string, unknown> }[] = [];
  const ctx = {
    run: { metadata: { name: "run-1", namespace: "default", uid: "u1" }, spec: { stage: "implement", step: "develop", outputs: [{ name: "spec" }] } },
    agent: { metadata: { name: "developer", namespace: "factory-system" }, spec: { tools: ["read_file"], sandboxRef: { name: "node-build" } } },
    skills: [], workItem: { metadata: { name: "item", namespace: "default" }, spec: {} },
    model: { provider: "copilot", providerType: "openai-compatible", model: "gpt-x", tier: "coding", client: {}, endpoint: { type: "openai-compatible" } },
    workspaces: [{ metadata: { name: "item-repo" }, spec: { repositoryRef: { name: "repo" } }, status: { phase: "Ready", path: "/tmp/ws", baseCommit: "a".repeat(40) } }],
    repositories: [], inputs: [], clarifications: [], approvals: [], sections: [],
    transcript: { ref: { namespace: "default", id: "t" }, record: async (m: { role: string; content: string; meta?: Record<string, unknown> }) => { transcript.push(m); } },
  } as unknown as ExecutionContext;
  return { ctx, transcript };
}

function executor(o: {
  runtime: FakeAgentRuntime;
  issued: Ref[];
  revoked: Ref[];
  profile?: "none" | "allowlist";
  export?: ExportIngestor;
}): AgentRuntimeExecutor {
  const tools = new Registry<AgentTool>();
  tools.register(TOOL.name, TOOL);
  const modelAccess: RuntimeModelAccess = {
    issue: async (run) => { o.issued.push(run); return { baseUrl: "http://proxy", token: "sfm_test" }; },
    revoke: async (run) => { o.revoked.push(run); return 1; },
  };
  return new AgentRuntimeExecutor({
    runtime: o.runtime,
    reader: { get: async (kind: string) => (kind === "SandboxProfile" ? PROFILE(o.profile) : null), list: async () => [] } as never,
    prompts: { build: () => ({ system: "SYS", user: "implement the spec" }) },
    tools,
    modelAccess,
    export: o.export ?? { ingest: async (i) => ({ commit: "b".repeat(40), ref: i.intoRef ?? "refs/factory/export/candidate", exportedRef: "refs/heads/factory/candidate", objects: 1, refs: 1, bytes: 1 }) },
    diff: { diff: async () => "" },
    mirrorsDir: mkdtempSync(join(tmpdir(), "sf-mirrors-")),
    capabilities: () => ({ read: { readFile: async () => "", listFiles: async () => [] } }),
    controlServer: createRunControlServerFactory({ proxy: async () => Response.json({ choices: [] }) }),
  });
}

test("S2-a: the executor issues a token, records runtime-reported events, ingests the export and maps finish", async () => {
  const issued: Ref[] = []; const revoked: Ref[] = [];
  const runtime = new FakeAgentRuntime({
    finish: { summary: "done", artifacts: [{ type: "spec", content: "# Spec" }] },
    events: [{ seq: 1, role: "assistant", content: "working" }],
    usage: { steps: 3 },
  });
  const ex = executor({ runtime, issued, revoked });
  const { ctx, transcript } = context();

  assert.equal(ex.canExecute(ctx), true);
  const result = await ex.execute(ctx);

  assert.equal(result.summary, "done");
  assert.deepEqual(result.artifacts, [{ type: "spec", content: "# Spec" }]);
  assert.equal(result.provenance?.runtime?.backend, "fake");
  assert.equal(result.provenance?.runtime?.exportedCommit, "b".repeat(40));
  assert.ok(transcript.some((m) => m.meta?.runtimeReported === true && /runtime-reported: working/.test(m.content)), "runtime events recorded as reported");
  assert.equal(runtime.lastSecrets?.modelToken, "sfm_test", "the runtime receives the run token out of band");
  assert.equal(issued.length, 1);
  assert.equal(revoked.length, 1);
});

test("S2-a: a non-object finish payload fails the run with a reason (ADR-0057)", async () => {
  const issued: Ref[] = []; const revoked: Ref[] = [];
  const runtime = new FakeAgentRuntime({ finish: "just a string" });
  const ex = executor({ runtime, issued, revoked });
  const { ctx } = context();
  await assert.rejects(ex.execute(ctx), /finish payload must be a JSON object/);
  assert.equal(revoked.length, 1);
});

test("S2-a: a waiting runtime becomes a model wait (ADR-0031); the token is still revoked", async () => {
  const issued: Ref[] = []; const revoked: Ref[] = [];
  const runtime = new FakeAgentRuntime({ status: "waiting", message: "quota", retryAfterMs: 1000 });
  const ex = executor({ runtime, issued, revoked });
  const { ctx } = context();
  await assert.rejects(ex.execute(ctx), ModelUnavailableError);
  assert.equal(revoked.length, 1);
});

test("S2-a: an unsupported network mode is refused before any token or job is created (ADR-0080 §7)", async () => {
  const issued: Ref[] = []; const revoked: Ref[] = [];
  const runtime = new FakeAgentRuntime({ network: ["none"] });
  const ex = executor({ runtime, issued, revoked, profile: "allowlist" });
  const { ctx } = context();
  await assert.rejects(ex.execute(ctx), (e: unknown) => e instanceof RuntimeRefusedError);
  assert.equal(issued.length, 0, "no token issued when the profile is refused");
  assert.equal(revoked.length, 0, "nothing to revoke: no job was created");
});

function jobSpec(o: { network?: "none" | "allowlist" } = {}) {
  return {
    run: { name: "run-1", namespace: "default" },
    namespace: "default",
    image: "fake@process",
    profile: PROFILE(o.network),
    seeds: [{ repository: "repo", commit: "a".repeat(40) }],
    model: { baseUrl: "http://proxy" },
    tools: { baseUrl: "http://tools" },
    task: { system: "S", user: "U", maxSteps: 5, protocol: 1 },
    budgets: { ttlSeconds: 60 },
  } as never;
}

// ── Composition root: the runtime path is off unless a backend is selected ────────────────────────────────────

test("S2-a: the runtime path is off by default (production unchanged); an unregistered backend fails loudly", async () => {
  // Default: no backend → no `AgentRuntimeExecutor` in the chain, factory builds as before.
  const f = await createFactory({ definitionsRoot: ROOT, definitionLoader: testDefinitions(), databasePath: ":memory:", env: { FACTORY_SANDBOX_RUNTIME: "none" }, log: () => {} });
  await f.start();
  try {
    assert.equal((await f.app.systemHealth(ANONYMOUS)).sandbox.runtime, "none");
  } finally {
    await f.stop();
  }

  await assert.rejects(
    createFactory({ definitionsRoot: ROOT, definitionLoader: testDefinitions(), databasePath: ":memory:", env: { FACTORY_SANDBOX_RUNTIME: "none", FACTORY_AGENT_RUNTIME_BACKEND: "nope" }, log: () => {} }),
    /did not resolve to an available AgentRuntime/,
  );
});

test("S2-a: with a registered backend the factory builds and starts (the seam works)", async () => {
  const f = await createFactory({
    definitionsRoot: ROOT, definitionLoader: testDefinitions(), databasePath: ":memory:",
    env: { FACTORY_SANDBOX_RUNTIME: "none", FACTORY_AGENT_RUNTIME_BACKEND: "fake" },
    agentRuntimes: [new FakeAgentRuntime()], log: () => {},
  });
  await f.start();
  try {
    assert.equal((await f.app.systemHealth(ANONYMOUS)).sandbox.runtime, "none");
  } finally {
    await f.stop();
  }
});
