# ADR-0090: Metrics in the UI — a first-class item view and per-run metrics

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** project owner
- **Extends:** ADR-0082 (metrics from the factory's own records), ADR-0075 (item panels)

## Context

ADR-0082 decided the metrics *model* — a `MetricsQueries` read model over transcripts and resources — and its surfaces: a
factory **Metrics** page in the nav and "a compact Metrics panel on the item page". Two shortcomings surfaced once the
model was in use:

1. **The item panel is hidden.** It is registered in the item page's `operational` region (ADR-0075), which the item page
   renders inside a **Details** accordion that is collapsed for planning-enabled items. The item's own numbers are
   therefore not visible where the item is read; a human must open "Details" first.
2. **A run has no numbers.** `MetricsQueries.run()` exists and `TranscriptMetrics` implements it, but there is no route
   and no UI. Inspecting a run (`RunDrawer`) shows the transcript and provenance but not the run's cost, tokens or
   agent-vs-tool time — the very question ("why was this run slow or expensive?") the read model was built to answer.

This ADR refines the metrics *surfaces* (not the model) and records the decision so the work can be resumed. Because it
changes the plan, it is tracked (AGENTS.md §5) and the milestone table gains **X62a** under X62's scope.

## Decision

**Keep the model, fix the surfaces: one item metrics surface in the main card, and metrics where a run is inspected.**

- **Item metrics become a first-class tab.** The item page's main card gains a **Metrics** tab beside Artifacts / Agent
  runs / Description. The `item-metrics` entry is removed from the `operational` panel registry, so there is exactly one
  item metrics surface. The tab shows: totals (runs, time in agent, time in tools, tokens, cost), a **per-run table**
  (agent, stage/step, wall, in-agent, in-tools, tokens, cost, tools; a row links to that run's drawer), tool bars
  (top-N by calls), the checks table, and a link to the factory Metrics page.
- **A run gets its own metrics.** Add `GET /api/runs/{name}/metrics` over the existing `MetricsQueries.run()`, and a
  compact `RunMetricsStrip` in the `RunDrawer` (steps, in-agent, in-tools, tokens, cost, tool count). No new port: the
  route is a thin adapter and `run()` already exists.
- **Shared presentation.** The `ms`/`n`/`usd`/`tokens` formatters and the metric `Info` tooltip currently duplicated
  between the factory page and the item panel move to one module; every metrics surface uses them.
- **Unknown stays omitted.** A value that was not recorded is absent and rendered `—`, never `0` (ADR-0082) — on the tab,
  the strip and the per-run table alike.
- **Prometheus stays factory-wide.** `MetricsExporter.export()` keeps no item selector: per-item labels would multiply
  series cardinality for no operator benefit. Item metrics are read through JSON (the tab and the run strip), not
  scraped. This reaffirms ADR-0082.

This adds no port, no resource kind and no schema change. Both query methods are already wired in the composition root
(ADR-0082), so no wiring change is needed either.

## Consequences

- **Positive:** an item's numbers are one click from the item (a tab, not a collapsed accordion), and a run's cost/time
  is visible in its drawer; the "recorded or `—`" honesty holds on all surfaces.
- **Positive:** the two duplicate formatter copies become one, so the surfaces cannot drift.
- **Negative / costs:** the item request still reads every one of the item's transcripts (O(runs)), as the item endpoint
  already did; the per-run route reads one transcript. A running-rollup (X32) remains the follow-up if volume grows
  (unchanged from ADR-0082).
- **Residual:** the per-run strip depends on the provider having reported usage; where it did not, tokens/time show `—`
  while tool counts still appear (unchanged from ADR-0082's residual).
- **No change to trust:** metrics are still computed from the factory's own records, never from a runtime's self-report.

**AGENTS.md sections and milestones affected:** §4 gains **X62a** (per-item and per-run metrics in the UI) under X62's
scope; §7's definition of done applies to the implementation, not to this plan-only change. No §3 layout change beyond new
files under `web/src/ui` and `web/src/app/api`.

## Alternatives considered

- **Keep the compact panel and just enrich it.** Rejected: the panel's placement is the problem — it sits in a collapsed
  accordion on the item page — so enriching it would not make it visible.
- **Give `MetricsExporter` an item dimension.** Rejected: per-item Prometheus series kill the Grafana value with
  unbounded label cardinality; the item tab already answers the per-item question.
- **Compute item metrics client-side from `WorkItemDetail.runs`.** Rejected: the numbers need transcripts, which the item
  detail does not carry; the server read model already exists.
- **A separate `/items/{name}/metrics` page.** Rejected: adds a nav surface and loses the item's context; a tab keeps it
  in place.
- **Leave it as untracked polish under X62.** Rejected: the placement change plus a new route are a plan change (§5), so
  they are recorded here and tracked as X62a rather than edited in silently.
