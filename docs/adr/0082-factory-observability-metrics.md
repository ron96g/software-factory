# ADR-0082: Factory observability — metrics from the factory's own records

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** project owner
- **Builds on:** ADR-0012 (transcripts), ADR-0052 (model usage), ADR-0075 (item panels)

## Context

The factory records a great deal — an append-only transcript per run, `AgentRun`/`CheckRun` resources with timing, and
provider usage on some paths — but it exposes almost none of it as *metrics*. An operator cannot answer "which tools do
agents actually use?", "how many tokens did this item cost?", "how much of a run is the model thinking vs a tool
running?", or "how long does the `unit-tests` check take?" without reading transcripts by hand.

Two facts shape the design:

1. **The factory already has the data.** A run's transcript holds model-call messages (with latency and, when the
   provider reports it, usage), tool-call/tool-result messages, and step numbers; resources hold `startedAt`/
   `finishedAt`, `durationMs`, outcomes and identity. Nothing here needs a runtime's self-report.
2. **Not every value is present.** The OpenCode host records tokens/cost for the providers that emit them; the in-factory
   tool loop now records usage and latency too. When a provider reports nothing, the value is **unknown** — and an
   unknown must not be rendered as a real `0`.

## Decision

**Record at the source, derive a read model, never guess.**

- **Recording.** The in-factory tool loop records a model call's latency and its provider-reported `usage`, and a tool
  call's latency (`DefaultRecordedToolTurns`); the three LLM adapters parse `usage` (`usage.prompt_tokens` /
  `usage.input_tokens` / `usageMetadata`) and return it. The OpenCode host already records tokens/cost where the SDK
  provides them. No new resource kind and no schema change: the fields live in the transcript message `meta` that
  ADR-0012 already defines.
- **Read model.** A `MetricsQueries` port (ISP, read-only) aggregates per run, per item and factory-wide:
  tool counts and time, time **in the agent** (sum of model-call latency) vs **in the tools** (sum of tool-call
  latency), steps, tokens, queue/wall time, check counts/durations and cost. The adapter is `TranscriptMetrics`; it
  depends only on `ResourceReader`, `TranscriptReader` and a `ModelPricing`.
- **Unknown is omitted, not zero.** `agentMs`, `toolMs`, `tokens`, a tool's `ms` and `costUsd` are optional; a metric
  that was not recorded is **absent** and the UI shows `—`. This is deliberate: a fabricated `0` corrupts averages and
  decisions.
- **Cost is an estimate, or nothing.** A provider-reported `cost` (OpenCode) is used as-is. Otherwise cost is estimated
  only from an **operator-provided, versioned** price schedule (`ModelPricing`; `FACTORY_MODEL_PRICES` JSON). There is
  no built-in price table: with none configured, cost is omitted and the UI says so. Estimates are labelled.
- **Surface.** `GET /api/metrics` (factory, `?since=&limit=`) and `GET /api/workitems/{name}/metrics` (item), plus a
  **Metrics** page in the nav (Mantine charts) and a compact **Metrics** panel on the item page (ADR-0075 registry,
  always applicable). For Grafana, `GET /api/metrics/prometheus` renders the same aggregates as Prometheus/OpenMetrics
  text via **`prom-client`** (a scrape pulls the current store totals as gauges; deleted items make them fall, so they
  are gauges, not counters — and an unrecorded metric is omitted, not exported as `0`).

## Consequences

- **Positive:** tools/tokens/agent-vs-tool time/checks/cost become visible per item and factory-wide, from data the
  factory already trusts. No runtime is involved in producing metrics, so a compromised runtime cannot inflate them.
- **Positive:** a metric that is unknown is honest — the UI distinguishes "0" from "not recorded".
- **Negative / costs:** reading every transcript on a factory-wide request is O(runs); `factory()` caps at `limit`
  (default 500) and can filter by `since`. A future increment can maintain running rollups (X32) if the volume grows.
- **Residual:** the OpenCode runtime's token/latency attribution depends on the provider emitting usage; where it does
  not, those runs show `—` for tokens/time even though tool *counts* are recorded.
- **No schema change:** usage/latency live in the transcript `meta` and metrics are computed on read.

**AGENTS.md sections and milestones affected:** §4 gains **X62** (factory metrics); **X32** (model usage and cost
accounting) moves from *Planned* to *In progress* — usage is now recorded on the tool-loop path and rolled up by the
metrics read model, with provider price estimates optional and correctable.
