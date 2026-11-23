import type { AgentRun, CheckRun, WorkItem } from "../model/kinds.ts";
import type {
  CheckMetrics,
  FactoryMetrics,
  ItemMetrics,
  MetricsQueries,
  MetricsTotals,
  ModelPricing,
  Principal,
  ResourceReader,
  RunMetrics,
  TokenTotals,
  ToolTotals,
  TranscriptReader,
} from "../ports/index.ts";

/**
 * ADR-0082: metrics derived from the factory's own records. A run's numbers come from its **transcript** (model-call
 * latency, tool-call/result latency, provider usage) and the resources (run/check timing, identity) — never from a
 * runtime's self-report. A value that was **not recorded is omitted**, not shown as zero; cost is the provider-reported
 * spend when present (e.g. OpenCode's `cost`), otherwise an estimate only when a price schedule matched (ADR-0052).
 */
export class TranscriptMetrics implements MetricsQueries {
  private readonly reader: ResourceReader;
  private readonly transcripts: TranscriptReader;
  private readonly pricing: ModelPricing;
  private readonly namespace: string;

  constructor(d: { reader: ResourceReader; transcripts: TranscriptReader; pricing: ModelPricing; namespace: string }) {
    this.reader = d.reader;
    this.transcripts = d.transcripts;
    this.pricing = d.pricing;
    this.namespace = d.namespace;
  }

  async run(_p: Principal, runName: string): Promise<RunMetrics | null> {
    const run = await this.reader.get<AgentRun>("AgentRun", this.namespace, runName);
    return run ? this.forRun(run) : null;
  }

  async item(_p: Principal, itemName: string): Promise<ItemMetrics | null> {
    const item = await this.reader.get<WorkItem>("WorkItem", this.namespace, itemName);
    if (!item) return null;
    const [runs, checks] = await Promise.all([
      this.reader.list<AgentRun>("AgentRun", { namespace: this.namespace, ownedBy: { kind: "WorkItem", name: itemName, namespace: this.namespace } }),
      this.reader.list<CheckRun>("CheckRun", { namespace: this.namespace, ownedBy: { kind: "WorkItem", name: itemName, namespace: this.namespace } }),
    ]);
    const metrics = (await Promise.all(runs.map((r) => this.forRun(r)))).sort((a, b) => a.run.name.localeCompare(b.run.name));
    return {
      workItem: item.metadata,
      runs: metrics,
      totals: { ...totals(metrics), tools: mergeTools(metrics) },
      checks: checkMetrics(checks),
      since: runs.map((r) => r.metadata.creationTimestamp ?? "").filter(Boolean).sort()[0],
    };
  }

  async factory(_p: Principal, options?: { since?: string; limit?: number }): Promise<FactoryMetrics> {
    const limit = options?.limit ?? 500;
    const since = options?.since;
    const [runs, items, checks] = await Promise.all([
      this.reader.list<AgentRun>("AgentRun", { namespace: this.namespace }),
      this.reader.list<WorkItem>("WorkItem", { namespace: this.namespace }),
      this.reader.list<CheckRun>("CheckRun", { namespace: this.namespace }),
    ]);
    const recent = (since ? runs.filter((r) => (r.metadata.creationTimestamp ?? "") >= since) : runs)
      .sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))
      .slice(0, limit);
    const metrics = await Promise.all(recent.map((r) => this.forRun(r)));

    const byAgent = new Map<string, { runs: number; agentMs?: number; toolMs?: number; tokens?: TokenTotals; costUsd?: number }>();
    const byStage = new Map<string, { runs: number; wallMs: number }>();
    for (const m of metrics) {
      const a = byAgent.get(m.agent) ?? { runs: 0 };
      a.runs++;
      if (m.agentMs !== undefined) a.agentMs = (a.agentMs ?? 0) + m.agentMs;
      if (m.toolMs !== undefined) a.toolMs = (a.toolMs ?? 0) + m.toolMs;
      if (m.tokens) a.tokens = a.tokens ? addTokens(a.tokens, m.tokens) : { ...m.tokens };
      if (m.costUsd !== undefined) a.costUsd = (a.costUsd ?? 0) + m.costUsd;
      byAgent.set(m.agent, a);
      const s = byStage.get(m.stage) ?? { runs: 0, wallMs: 0 };
      s.runs++;
      s.wallMs += m.wallMs ?? 0;
      byStage.set(m.stage, s);
    }
    const byTool = Object.entries(mergeTools(metrics)).map(([tool, t]) => ({ tool, ...t })).sort((a, b) => b.calls - a.calls || (b.ms ?? 0) - (a.ms ?? 0));
    const windowedChecks = since ? checks.filter((c) => (c.metadata.creationTimestamp ?? "") >= since) : checks;

    return {
      generatedAt: new Date().toISOString(),
      since,
      totals: { ...totals(metrics), items: items.length, tools: mergeTools(metrics) },
      byAgent: [...byAgent].map(([agent, v]) => ({ agent, ...v })).sort((a, b) => b.runs - a.runs),
      byStage: [...byStage].map(([stage, v]) => ({ stage, ...v })).sort((a, b) => b.wallMs - a.wallMs),
      byTool,
      checks: checkMetrics(windowedChecks),
      pricing: this.pricing.version && this.pricing.source ? { version: this.pricing.version, source: this.pricing.source } : undefined,
    };
  }

  /** A run's transcript holds model-call latency/usage and tool-call/results; the resource holds timing and identity. */
  private async forRun(run: AgentRun): Promise<RunMetrics> {
    const tokens: TokenTotals = { prompt: 0, completion: 0, total: 0 };
    const tools: Record<string, ToolTotals> = {};
    let agentMs = 0, toolMs = 0, steps = 0, tokensUnknownCalls = 0;
    let hasAgent = false, hasTool = false, hasTokens = false;
    let reportedCost = 0, reportedAny = false, estimatedCost = 0, estimatedAny = false;

    if (run.status?.transcriptRef) {
      for (const m of await this.transcripts.read(run.status.transcriptRef)) {
        const meta = (m.meta ?? {}) as Record<string, unknown>;
        if (m.role === "assistant") {
          if (typeof meta.latencyMs === "number") { agentMs += meta.latencyMs; hasAgent = true; }
          if (typeof meta.step === "number") steps = Math.max(steps, meta.step);
          const t = meta.tokens as { prompt?: number; completion?: number; total?: number } | undefined;
          if (t) {
            tokens.prompt += t.prompt ?? 0;
            tokens.completion += t.completion ?? 0;
            tokens.total += t.total ?? (t.prompt ?? 0) + (t.completion ?? 0);
            hasTokens = true;
          } else if (meta.model) tokensUnknownCalls++;
          if (typeof meta.cost === "number") { reportedCost += meta.cost; reportedAny = true; }
          else if (t && meta.model) {
            const e = this.pricing.estimate(String(meta.model), { prompt: t.prompt ?? 0, completion: t.completion ?? 0 });
            if (e.matched) { estimatedCost += e.usd; estimatedAny = true; } // unmatched: omit rather than guess
          }
        } else if (m.role === "tool-call") {
          const name = String(meta.tool ?? "unknown");
          const cur = tools[name] ?? { calls: 0 };
          tools[name] = { calls: cur.calls + 1, ...(cur.ms !== undefined ? { ms: cur.ms } : {}) };
        } else if (m.role === "tool-result") {
          const name = String(meta.tool ?? "unknown");
          const cur = tools[name] ?? { calls: 0 };
          const ms = typeof meta.latencyMs === "number" ? meta.latencyMs : undefined;
          if (ms !== undefined) { hasTool = true; toolMs += ms; }
          tools[name] = { calls: cur.calls, ...(ms !== undefined || cur.ms !== undefined ? { ms: (cur.ms ?? 0) + (ms ?? 0) } : {}) };
        }
      }
    }
    // Steps and tool counts also live in provenance (present even when a transcript is unreadable).
    steps = Math.max(steps, run.status?.provenance?.toolUse?.steps ?? 0);
    const calls = run.status?.provenance?.toolUse?.calls;
    if (!Object.keys(tools).length && calls) for (const [name, n] of Object.entries(calls)) tools[name] = { calls: n };

    const created = run.metadata.creationTimestamp ? Date.parse(run.metadata.creationTimestamp) : undefined;
    const started = run.status?.startedAt ? Date.parse(run.status.startedAt) : undefined;
    const finished = run.status?.finishedAt ? Date.parse(run.status.finishedAt) : undefined;
    return {
      run: run.metadata,
      agent: run.spec.agentRef.name,
      stage: run.spec.stage,
      step: run.spec.step,
      executor: run.status?.executor,
      queueMs: created !== undefined && started !== undefined ? Math.max(0, started - created) : undefined,
      wallMs: started !== undefined && finished !== undefined ? Math.max(0, finished - started) : undefined,
      agentMs: hasAgent ? agentMs : undefined,
      toolMs: hasTool ? toolMs : undefined,
      steps,
      tools,
      tokens: hasTokens ? tokens : undefined,
      costUsd: reportedAny || estimatedAny ? reportedCost + estimatedCost : undefined,
      costEstimated: estimatedAny ? true : undefined,
      tokensUnknownCalls,
    };
  }
}

const addTokens = (a: TokenTotals, b: TokenTotals): TokenTotals => ({ prompt: a.prompt + b.prompt, completion: a.completion + b.completion, total: a.total + b.total });

function mergeTools(metrics: RunMetrics[]): Record<string, ToolTotals> {
  const out: Record<string, ToolTotals> = {};
  for (const m of metrics) {
    for (const [name, t] of Object.entries(m.tools)) {
      const cur = out[name] ?? { calls: 0 };
      const ms = t.ms !== undefined || cur.ms !== undefined ? (cur.ms ?? 0) + (t.ms ?? 0) : undefined;
      out[name] = { calls: cur.calls + t.calls, ...(ms !== undefined ? { ms } : {}) };
    }
  }
  return out;
}

function totals(metrics: RunMetrics[]): MetricsTotals {
  const acc: MetricsTotals = { runs: metrics.length };
  for (const m of metrics) {
    if (m.agentMs !== undefined) acc.agentMs = (acc.agentMs ?? 0) + m.agentMs;
    if (m.toolMs !== undefined) acc.toolMs = (acc.toolMs ?? 0) + m.toolMs;
    if (m.tokens) acc.tokens = acc.tokens ? addTokens(acc.tokens, m.tokens) : { ...m.tokens };
    if (m.costUsd !== undefined) acc.costUsd = (acc.costUsd ?? 0) + m.costUsd;
    if (m.costEstimated) acc.costEstimated = true;
  }
  return acc;
}

function checkMetrics(checks: CheckRun[]): CheckMetrics[] {
  const out = new Map<string, CheckMetrics>();
  for (const c of checks) {
    const name = c.spec.check;
    const cur = out.get(name) ?? { check: name, runs: 0, failed: 0, ms: 0 };
    cur.runs++;
    if (c.status?.outcome && c.status.outcome !== "Passed") cur.failed++;
    cur.ms += c.status?.durationMs ?? 0;
    out.set(name, cur);
  }
  return [...out.values()].sort((a, b) => b.runs - a.runs);
}
