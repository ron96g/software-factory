# ADR-0031: An unavailable model makes a run wait, not fail

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** project owner
- **Extends:** ADR-0005, ADR-0014, ADR-0029

## Context
Providers reject calls when a quota is used up or a rate limit is hit (HTTP 429), or when they are overloaded
(503, Anthropic 529). Until now any such error failed the AgentRun, which failed the whole work item. The agent did
nothing wrong, and the same call usually works later (a rate limit after seconds, a quota after a reset or a budget
change).

## Decision
- LLM adapters map HTTP 429/503/529 to `ModelUnavailableError` (port), with `Retry-After` when the provider sends it.
- The AgentRun controller treats it as waiting: the run goes back to `Pending` with `status.retryAt` (from
  `Retry-After`, else exponential backoff from 1 minute; always capped at 15 minutes, because a quota's Retry-After
  can point weeks ahead while a new token or budget fixes it now; counted in `status.modelWaits`). After a factory
  restart (when tokens and providers usually change), a waiting run retries once right away, records a
  note in the run's transcript (rule 14), and emits one `ModelUnavailable` warning per wait period. The reconcile
  requeues until `retryAt`, then executes again in the same transcript. Success clears the counters.
- The work item shows it: while its current run waits (for the model, or for a real executor under
  `FACTORY_SIMULATION=wait`), the WorkItem controller sets phase **`Waiting`** with the run's reason in
  `status.message`, and back to `Running` once the run proceeds. A retry attempt keeps the item `Waiting`, so the phase
  and the timeline don't flicker on every retry.
- Superseded runs are still cancelled immediately (ADR-0029). API calls that hit an unavailable model return HTTP 503.

## Consequences
- An exhausted quota pauses work instead of failing items; it resumes by itself once calls succeed again.
- A long outage keeps runs waiting indefinitely (at most one attempt per 15 minutes). That is visible on the run and
  in the item timeline; a human can still restart or delete the item.

## Alternatives considered
- Fail fast (previous behaviour): forces a manual restart for a problem outside the factory.
- Fall back to another provider automatically: may silently change cost, data residency, or quality; a deliberate
  `ModelProvider` choice is better (ADR-0014).
