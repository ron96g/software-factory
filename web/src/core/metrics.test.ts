import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptMetrics } from "./metrics/transcript-metrics.ts";
import { DefaultModelPricing } from "./metrics/pricing.ts";
import type { AgentRun, CheckRun } from "./model/kinds.ts";
import type { Principal, TranscriptMessage } from "./ports/index.ts";

const ANON: Principal = { id: "anonymous", roles: [], squads: [] };
const AT = "2026-11-23T10:00:00.000Z";

function reader(resources: { kind: string; metadata: { name: string } }[]) {
  const map = new Map(resources.map((r) => [`${r.kind}/${r.metadata.name}`, r]));
  return {
    get: async (kind: string, _ns: string, name: string) => (map.get(`${kind}/${name}`) as never) ?? null,
    list: async (kind: string) => [...map.values()].filter((r) => r.kind === kind) as never,
  } as never;
}

function run(name: string, over: Partial<AgentRun["status"]> = {}, spec: Partial<AgentRun["spec"]> = {}): AgentRun {
  return {
    apiVersion: "v", kind: "AgentRun",
    metadata: { name, namespace: "default", creationTimestamp: AT },
    spec: { agentRef: { name: "developer" }, stage: "implement", step: "write-code", workItemRef: { name: "item-1" }, outputs: [], ...spec },
    status: { phase: "Succeeded", startedAt: "2026-11-23T10:00:01.000Z", finishedAt: "2026-11-23T10:00:03.000Z", transcriptRef: { namespace: "default", id: name }, ...over },
  } as unknown as AgentRun;
}

const msg = (role: TranscriptMessage["role"], meta: Record<string, unknown>): TranscriptMessage =>
  ({ seq: 1, at: AT, role, author: { type: "system", id: "t" }, content: "", meta }) as unknown as TranscriptMessage;

test("metrics: aggregates tools, tokens, agent/tool time and cost from the transcript", async () => {
  const messages: TranscriptMessage[] = [
    msg("assistant", { step: 1, model: "mdl-x", latencyMs: 100, tokens: { prompt: 10, completion: 5, total: 15 } }),
    msg("tool-call", { tool: "read", step: 1 }),
    msg("tool-result", { tool: "read", step: 1, latencyMs: 20 }),
    msg("assistant", { step: 2, model: "mdl-x", latencyMs: 50 }), // usage not reported → unknown
    msg("tool-call", { tool: "read", step: 2 }),
    msg("tool-result", { tool: "read", step: 2, latencyMs: 5 }),
  ];
  const r = run("run-1", { provenance: { toolUse: { steps: 2, calls: { read: 2 }, finishCorrections: 0 } } as never });
  const metrics = new TranscriptMetrics({
    reader: reader([r]),
    transcripts: { read: async () => messages } as never,
    pricing: new DefaultModelPricing({ version: "test", source: "test", prices: [{ prefix: "mdl", prompt: 1, completion: 1 }] }),
    namespace: "default",
  });

  const m = (await metrics.run(ANON, "run-1"))!;
  assert.equal(m.agentMs, 150, "sum of model-call latency");
  assert.equal(m.toolMs, 25, "sum of tool-call latency");
  assert.deepEqual(m.tools, { read: { calls: 2, ms: 25 } });
  assert.deepEqual(m.tokens, { prompt: 10, completion: 5, total: 15 });
  assert.equal(m.tokensUnknownCalls, 1, "one model call reported no usage");
  assert.ok(Math.abs((m.costUsd ?? 0) - 15 / 1_000_000) < 1e-12, "estimated from the configured schedule only");
  assert.equal(m.costEstimated, true);
  assert.equal(m.steps, 2);
  assert.equal(m.queueMs, 1000);
  assert.equal(m.wallMs, 2000);
});

test("metrics: a value that was not recorded is omitted, never zero", async () => {
  // No latency, no usage, no cost anywhere — only tool counts (from provenance, as OpenCode records them).
  const r = run("run-2", { provenance: { toolUse: { steps: 3, calls: { shell: 2, finish: 1 }, finishCorrections: 0 } } as never });
  const metrics = new TranscriptMetrics({
    reader: reader([r]),
    transcripts: { read: async () => [msg("tool-call", { tool: "shell", step: 1 }), msg("tool-result", { tool: "shell", step: 1 })] } as never,
    pricing: new DefaultModelPricing(), // no schedule configured
    namespace: "default",
  });

  const m = (await metrics.run(ANON, "run-2"))!;
  assert.equal(m.agentMs, undefined, "no model-call latency recorded → omitted");
  assert.equal(m.toolMs, undefined, "no tool-call latency recorded → omitted");
  assert.equal(m.tokens, undefined, "no usage recorded → omitted");
  assert.equal(m.costUsd, undefined, "no cost and no price schedule → omitted");
  assert.deepEqual(m.tools, { shell: { calls: 1 } }, "tool counts recorded, per-tool time omitted");
});

test("metrics: factory rollup groups by agent and tool, and check failures", async () => {
  const r1 = run("run-a", { provenance: { toolUse: { steps: 1, calls: { read: 1 }, finishCorrections: 0 } } as never });
  const r2 = run("run-b", { provenance: { toolUse: { steps: 1, calls: { run: 1 }, finishCorrections: 0 } } as never }, { agentRef: { name: "verifier" }, stage: "verify", step: "verify-against-spec" });
  const check = { apiVersion: "v", kind: "CheckRun", metadata: { name: "check-1", namespace: "default", creationTimestamp: AT }, spec: { check: "unit-tests", workItemRef: { name: "item-1" }, workItemUid: "u", workspaceRef: { name: "w" }, requestId: "r" }, status: { phase: "Completed", outcome: "Failed", durationMs: 1234 } } as unknown as CheckRun;
  const item = { apiVersion: "v", kind: "WorkItem", metadata: { name: "item-1", namespace: "default" }, spec: {} };
  const metrics = new TranscriptMetrics({
    reader: reader([r1, r2, check, item] as never),
    transcripts: { read: async () => [] } as never,
    pricing: new DefaultModelPricing(),
    namespace: "default",
  });

  const f = await metrics.factory(ANON);
  assert.deepEqual(f.byAgent.map((a) => a.agent).sort(), ["developer", "verifier"]);
  assert.deepEqual(f.byTool.map((t) => t.tool).sort(), ["read", "run"]);
  assert.deepEqual(f.checks, [{ check: "unit-tests", runs: 1, failed: 1, ms: 1234 }]);
  assert.equal(f.pricing, undefined, "no schedule → no pricing claim");
});
