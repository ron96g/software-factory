import { Gauge, Registry } from "prom-client";
import type { FactoryMetrics, MetricsExporter, MetricsQueries, Principal } from "../ports/index.ts";

/**
 * ADR-0082: renders the factory metrics as Prometheus/OpenMetrics **gauges** (via `prom-client`) for scraping. Values
 * are the current aggregates over the store (they grow with history and can fall when items are deleted, so they are
 * gauges, not counters). A metric that was not recorded is **omitted**, never exported as a fabricated `0`, so a Grafana
 * panel can tell "unknown" from "zero".
 */
export class PrometheusMetricsExporter implements MetricsExporter {
  private readonly metrics: MetricsQueries;

  constructor(metrics: MetricsQueries) {
    this.metrics = metrics;
  }

  async export(p: Principal, options?: { since?: string; limit?: number }): Promise<{ contentType: string; body: string }> {
    return render(await this.metrics.factory(p, options));
  }
}

type Sample = [Record<string, string> | undefined, number | undefined];

export async function render(fm: FactoryMetrics): Promise<{ contentType: string; body: string }> {
  const registry = new Registry();
  const gauge = (name: string, help: string, labelNames: string[], samples: Sample[]) => {
    const rows = samples.filter(([, v]) => typeof v === "number" && Number.isFinite(v)) as [Record<string, string> | undefined, number][];
    if (!rows.length) return; // omit entirely when unknown — never a fabricated 0
    const g = new Gauge({ name, help, labelNames, registers: [registry] });
    for (const [labels, value] of rows) g.set((labels ?? {}) as Record<string, string>, value);
  };

  gauge("factory_items", "Work items in the store.", [], [[undefined, fm.totals.items]]);
  gauge("factory_runs", "Agent runs considered.", [], [[undefined, fm.totals.runs]]);
  gauge("factory_agent_milliseconds", "Recorded time in the agent (model calls).", [], [[undefined, fm.totals.agentMs]]);
  gauge("factory_tool_milliseconds", "Recorded time in tools.", [], [[undefined, fm.totals.toolMs]]);
  gauge("factory_cost_usd", "Estimated or provider-reported spend in USD.", ["estimated"], [[{ estimated: fm.totals.costEstimated ? "true" : "false" }, fm.totals.costUsd]]);
  if (fm.totals.tokens) {
    gauge("factory_tokens", "Prompt/completion tokens.", ["kind"], [
      [{ kind: "prompt" }, fm.totals.tokens.prompt],
      [{ kind: "completion" }, fm.totals.tokens.completion],
      [{ kind: "total" }, fm.totals.tokens.total],
    ]);
  }

  gauge("factory_tool_calls", "Tool calls by tool.", ["tool"], fm.byTool.map((t) => [{ tool: t.tool }, t.calls]));
  gauge("factory_tool_milliseconds_by_tool", "Recorded tool time by tool.", ["tool"], fm.byTool.map((t) => [{ tool: t.tool }, t.ms]));
  gauge("factory_agent_runs", "Runs by agent.", ["agent"], fm.byAgent.map((a) => [{ agent: a.agent }, a.runs]));
  gauge("factory_agent_milliseconds_by_agent", "Recorded agent time by agent.", ["agent"], fm.byAgent.map((a) => [{ agent: a.agent }, a.agentMs]));
  gauge("factory_agent_tool_milliseconds_by_agent", "Recorded tool time by agent.", ["agent"], fm.byAgent.map((a) => [{ agent: a.agent }, a.toolMs]));
  gauge("factory_stage_runs", "Runs by stage.", ["stage"], fm.byStage.map((s) => [{ stage: s.stage }, s.runs]));
  gauge("factory_check_runs", "Check runs by check and outcome.", ["check", "outcome"], fm.checks.flatMap((c) => [
    [{ check: c.check, outcome: "passed" }, c.runs - c.failed],
    [{ check: c.check, outcome: "failed" }, c.failed],
  ]));
  gauge("factory_check_milliseconds", "Recorded check time by check.", ["check"], fm.checks.map((c) => [{ check: c.check }, c.ms]));

  return { contentType: registry.contentType, body: await registry.metrics() };
}
