# ADR-0052: Provider-reported model usage and estimated workflow cost

- **Status:** Proposed
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Builds on:** ADR-0012, ADR-0014, ADR-0028

## Context
The factory records prompts, responses, model provenance and tool activity, but its LLM clients discard provider usage
metadata. A transcript therefore cannot currently answer how many tokens a run or workflow consumed. Nor can an
account-level billing report be reliably joined back to a WorkItem.

Providers report different usage categories. Cached input may be included in a provider's input total or reported
separately; cache writes and reasoning tokens may have distinct pricing. The model billed by the provider may also
differ from the model the factory currently records: the resolver selects an agent-specific model, while the
OpenAI-compatible client chooses its model from the tier again.

A token count is not an invoice amount. Provider prices change, cached tokens may have different rates, and Copilot
entitlements, AI credits, multipliers and plan allowances do not necessarily correspond to a per-request USD charge.
Existing transcripts cannot recover usage that was discarded when the response arrived.

## Decision
### 1. Record each model call as durable, attributable evidence
- Every LLM request made by a workflow run, replay or Conversation goes through one shared recorded-call boundary.
  The boundary allocates a unique call ID and appends a start record before sending the request. It appends a
  completion record with the assistant response and structured usage immediately after receiving the response.
  Provider errors and calls interrupted before a completion record remain visibly incomplete; their usage is unknown,
  not zero.
- Define role-specific core ports for recorded plain completions and recorded tool completions before implementing
  them. Both use a shared recorder backed by `TranscriptRecorder`; providers remain transport adapters and do not own
  workflow attribution or transcript persistence. Wire the ports only in the composition root.
- Extend the `LLMClient` and `ToolCallingLLM` result contracts to return response text/tool calls, the provider's
  reported usage when present, and the actual model identifier when the provider supplies one. Each registered
  adapter owns translation from its native response fields; unknown or ambiguous fields are not guessed.
- Store call records in the existing append-only transcript, through `TranscriptRecorder`, with provider, requested
  and reported model IDs, call ID, outcome, native usage fields and normalized usage. Do not store prompts or responses
  in a new accounting log. Existing transcript redaction and namespace scoping apply.
- Normalized `inputTokens` and `outputTokens` are totals. Cached input and cache-write input, when reported, are
  disjoint subsets of `inputTokens`; reasoning output is a subset of `outputTokens`. They explain those totals and
  must not be added a second time. Preserve native provider fields so normalization remains auditable. If provider
  semantics do not permit deriving a total and its categories confidently, leave the affected values unavailable.
- All invocation paths use the same boundary: normal and delegated AgentRuns, tool-loop iterations, replays, and
  model-backed explain/refinement/chat Conversations. Tool calls themselves are not model tokens; the model request
  that produced a tool call is counted once.
- A request's concrete model is resolved once and is the model sent by the adapter. Record both requested and
  provider-reported model IDs where available; never attribute usage using only a tier or a model name inferred from
  current configuration.
- Do not pass a successful model response to an agent until its completion/usage record is durably appended. If that
  append fails, surface the error and leave the call visibly incomplete rather than continuing with unrecorded work.
  A process crash after a provider completes a request but before its response is durably recorded cannot be made
  atomic with the provider; report that gap as unknown usage.

### 2. Derive totals without inventing completeness
- Derive per-run usage from its transcript call records and WorkItem usage from its AgentRuns. Do not maintain a
  second mutable token counter in resource status. Existing resources need no migration.
- A WorkItem workflow total includes all workflow attempts, including failed, retried, superseded and delegated
  runs, because each may have incurred model usage. A delegated run is included once. Show replays separately and
  allow them to be included in an all-attempts total. Conversation usage is reported separately from workflow usage;
  it is not silently attributed to the workflow.
- Show observed totals as partial whenever an attempted call has no reported usage. Show unavailable values as
  unavailable, never as zero. Existing runs without call records remain historical with unknown usage; do not
  backfill by estimating from transcript text, matching provider account reports by time, or tokenizing prompts.
- Prices and model mappings are resolved for the request and retained with its usage record. Later price changes must
  not rewrite historical estimates.

### 3. Distinguish provider charges from estimates
- A monetary value is labeled **provider-reported** only when a provider returns a documented monetary amount and
  currency for that specific call. Provider usage counts, premium-request multipliers, AI credits and nano-AI units
  are not USD and are not represented as an invoice charge.
- Where a provider supplies token counts but no per-call monetary charge, the factory may compute an **estimate** from
  an operator-maintained, versioned pricing schedule in `ModelProvider` configuration. The schedule is keyed by
  provider and actual model (and any price-affecting context class), identifies currency and effective dates, and has
  separate rates for uncached input, cached input, cache-write input and output. Price each input token exactly once:
  uncached input is `inputTokens - cachedInputTokens - cacheWriteInputTokens`, with the two subsets treated as
  disjoint; price output using `outputTokens` once. Reasoning output is not added to output a second time. Store the
  applicable schedule revision, rates used and calculated amount with the call record. If the adapter cannot
  establish non-overlapping billable buckets or a required rate is missing, the estimate is unavailable.
- If an applicable model, usage category, currency or rate is missing or ambiguous, the estimate is unavailable.
  Never silently use current prices for historical calls, scrape prices at runtime, assume a zero rate, or present an
  estimate as actual spend. Copilot-specific amounts remain unavailable unless their documented semantics and
  reconciliation to billing are established.
- This feature reports model usage/cost only. It does not claim workflow-level invoice reconciliation or include
  non-model costs such as sandbox compute.

### 4. Present the evidence in the existing run and WorkItem views
- Show per-call/per-run input and output totals, reported category breakdowns, model and provider, and estimated cost
  when available. Show WorkItem workflow, replay and Conversation totals separately.
- Label estimates, currency, and missing/partial data in the UI and API. Historical records and interrupted calls
  must not appear complete merely because no usage was found.

## Consequences
- This is a forward-looking capability; discarded historical usage cannot be reconstructed.
- The LLM ports and all direct model callers must be updated together. Provider adapters need contract tests for
  native usage parsing, cache-category semantics and actual model attribution. Providers that do not return
  dependable usage remain usable, but their accounting is explicitly incomplete.
- The direct GitHub Copilot endpoint must pass a provider-specific feasibility/contract test for its usage fields
  before those fields are counted. The Copilot SDK's documented session usage is not evidence about a separate
  direct API request.
- A versioned pricing schedule requires operator maintenance and does not guarantee a match to a provider invoice.
  Copilot SDK metrics are not a drop-in source for this factory's direct API calls: its session totals cover a
  separate Copilot CLI agent loop, and its cost fields must not be interpreted as USD without authoritative
  semantics.
- AGENTS.md tracks this as X32. The exit criteria require provider contract tests, durable accounting across restart,
  complete call-path coverage, correct rollups, and UI/API labels for estimated, unavailable and partial values.
  X32 is not complete until Copilot usage behavior has been verified or explicitly marked unsupported.

## Alternatives considered
- Estimate tokens from prompt/response character counts or a tokenizer: rejected because it cannot reproduce provider
  billing, cache treatment, hidden reasoning, or model-specific tokenization.
- Reconstruct costs from current price tables or account-level usage reports after a run: rejected because rates
  change and aggregate provider reports cannot reliably identify the WorkItem, attempts or calls that incurred usage.
- Replace the factory's model execution with the Copilot SDK to obtain its session metrics: rejected as the default
  design because that SDK delegates the agent loop to Copilot CLI, unlike the factory's recorded, sandbox-bound tool
  loop. It is not a drop-in accounting adapter.
- Store a mutable usage total on AgentRun or WorkItem status: rejected because it duplicates append-only evidence and
  creates consistency and restart-recovery problems.
