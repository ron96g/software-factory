/**
 * Factory observability (ADR-0082). Metrics are derived from the factory's **own** records — transcripts (model calls,
 * tool calls/results, provider usage and latency) and resources (`AgentRun`, `CheckRun`, `WorkItem`) — never from a
 * runtime's self-report. Every amount is bounded and labelled; cost is always an **estimate** unless the provider
 * reported it (ADR-0052).
 */
import type { Ref } from "../model/resource.ts";
import type { Principal } from "./app.ts";

export interface TokenTotals {
  prompt: number;
  completion: number;
  total: number;
}

export interface ToolTotals {
  calls: number;
  /** Sum of recorded tool-call latencies; omitted when no call recorded one. */
  ms?: number;
}

/** One `AgentRun`: time in the agent (model calls) vs time in tools, tool counts, tokens and (estimated) cost. */
export interface RunMetrics {
  run: Ref;
  agent: string;
  stage: string;
  step: string;
  executor?: string;
  /** Creation → `startedAt`: queue/wait time, including model-unavailable waits (ADR-0031). */
  queueMs?: number;
  /** `startedAt` → `finishedAt`. */
  wallMs?: number;
  /** Sum of model-call latencies ("in the agent"); omitted when no call recorded a latency. */
  agentMs?: number;
  /** Sum of tool-call latencies ("in the tools"); omitted when no call recorded a latency. */
  toolMs?: number;
  steps: number;
  tools: Record<string, ToolTotals>;
  /** Provider-reported tokens; omitted when no call reported usage (unknown, not zero). */
  tokens?: TokenTotals;
  /** USD — present only when the provider reported a cost or a configured price matched. Never guessed. */
  costUsd?: number;
  /** True when `costUsd` includes a price-schedule estimate (a subset of the calls). */
  costEstimated?: boolean;
  /** Model calls that carried a model id but no usage. */
  tokensUnknownCalls: number;
}

export interface MetricsTotals {
  runs: number;
  agentMs?: number;
  toolMs?: number;
  tokens?: TokenTotals;
  /** Present only when at least one run had a known cost. */
  costUsd?: number;
  costEstimated?: boolean;
}

export interface ItemMetrics {
  workItem: Ref;
  runs: RunMetrics[];
  totals: MetricsTotals & { tools: Record<string, ToolTotals> };
  checks: CheckMetrics[];
  since?: string;
}

export interface CheckMetrics {
  check: string;
  runs: number;
  failed: number;
  ms: number;
}

export interface FactoryMetrics {
  generatedAt: string;
  since?: string;
  totals: MetricsTotals & { items: number; tools: Record<string, ToolTotals> };
  byAgent: { agent: string; runs: number; agentMs?: number; toolMs?: number; tokens?: TokenTotals; costUsd?: number }[];
  byStage: { stage: string; runs: number; wallMs: number }[];
  byTool: { tool: string; calls: number; ms?: number }[];
  checks: CheckMetrics[];
  /** The price schedule used for estimates, when one is configured. */
  pricing?: { version: string; source: string };
}

/** Read-only metrics (ISP): the UI/API depend on this, never on the aggregation. */
export interface MetricsQueries {
  run(p: Principal, runName: string): Promise<RunMetrics | null>;
  item(p: Principal, itemName: string): Promise<ItemMetrics | null>;
  factory(p: Principal, options?: { since?: string; limit?: number }): Promise<FactoryMetrics>;
}

/** Renders metrics in a scrape format (Prometheus/OpenMetrics) for Grafana et al. Separate from reading (ISP, ADR-0082). */
export interface MetricsExporter {
  export(p: Principal, options?: { since?: string; limit?: number }): Promise<{ contentType: string; body: string }>;
}

/**
 * ADR-0052: an optional, versioned price schedule for **estimates**. Prices are USD per 1,000,000 tokens, matched by a
 * model-id prefix; a miss records `matched: false` so the UI can label the total as partial. Never an invoice.
 */
export interface ModelPricing {
  readonly version?: string;
  readonly source?: string;
  estimate(model: string, tokens: { prompt: number; completion: number }): { usd: number; matched: boolean };
}
