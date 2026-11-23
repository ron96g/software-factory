import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "./metrics/prometheus.ts";
import type { FactoryMetrics } from "./ports/index.ts";

const fm = (over: Partial<FactoryMetrics["totals"]> = {}): FactoryMetrics => ({
  generatedAt: "2026-11-23T00:00:00.000Z",
  totals: { runs: 5, items: 2, agentMs: 1000, toolMs: 200, tokens: { prompt: 10, completion: 5, total: 15 }, tools: {}, ...over },
  byAgent: [{ agent: "developer", runs: 2, agentMs: 800, toolMs: 100 }],
  byStage: [{ stage: "implement", runs: 2, wallMs: 3000 }],
  byTool: [{ tool: "run", calls: 3, ms: 120 }, { tool: "finish", calls: 2 }],
  checks: [{ check: "unit-tests", runs: 4, failed: 1, ms: 900 }],
});

test("prometheus export: renders gauges with labels and omits unknown metrics", async () => {
  const { body: text, contentType } = await render(fm());
  assert.match(contentType, /text\/plain/);
  assert.match(text, /# TYPE factory_runs gauge/);
  assert.match(text, /^factory_runs 5$/m);
  assert.match(text, /^factory_agent_milliseconds 1000$/m);
  assert.match(text, /^factory_tool_milliseconds 200$/m);
  assert.match(text, /^factory_tokens\{kind="total"\} 15$/m);
  assert.match(text, /^factory_tool_calls\{tool="run"\} 3$/m);
  assert.match(text, /^factory_tool_calls\{tool="finish"\} 2$/m);
  assert.match(text, /^factory_tool_milliseconds_by_tool\{tool="run"\} 120$/m);
  assert.match(text, /^factory_agent_runs\{agent="developer"\} 2$/m);
  assert.match(text, /^factory_check_runs\{check="unit-tests",outcome="passed"\} 3$/m);
  assert.match(text, /^factory_check_runs\{check="unit-tests",outcome="failed"\} 1$/m);
  assert.doesNotMatch(text, /factory_cost_usd/, "no cost recorded → omitted, never a fabricated 0");
  assert.doesNotMatch(text, /factory_tool_milliseconds_by_tool\{tool="finish"\}/, "a tool with no recorded time is omitted");
});

test("prometheus export: unknown totals are omitted entirely", async () => {
  const { body: text } = await render({ ...fm(), totals: { runs: 3, items: 1, tokens: undefined, tools: {} } });
  assert.match(text, /^factory_runs 3$/m);
  assert.doesNotMatch(text, /factory_agent_milliseconds 0/);
  assert.doesNotMatch(text, /factory_tokens/);
});
