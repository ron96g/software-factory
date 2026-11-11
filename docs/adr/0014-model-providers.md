# ADR-0014: Model providers & tier mapping

- **Status:** Accepted (MVP: one provider config + OpenAI-compatible and Anthropic adapters, in M3)
- **Date:** 2026-11-11

## Context
Agents must be able to use OpenAI, Anthropic, or other LLMs without changing their definitions. The `LLMClient` port only
returns text, but delegation (e.g. to `code-researcher`) needs tool calling.

## Decision
- Agents and steps only declare **`model.tier`** (`reasoning | coding | fast`, extensible). They never name a provider.
- New definition kind **`ModelProvider`** (namespace-scoped, ADR-0011):
  ```yaml
  kind: ModelProvider
  metadata: { name: anthropic, namespace: factory-system }
  spec:
    type: anthropic            # registry key: openai-compatible | anthropic | …
    baseUrl: https://api.anthropic.com
    secretRef: { name: anthropic-api-key }
    models: { reasoning: claude-opus-…, coding: claude-sonnet-…, fast: claude-haiku-… }
    default: true
  ```
- **Resolution:** an explicit `model.providerRef` on the step or agent wins. Otherwise use the namespace's default provider,
  then the `factory-system` default. The tier is then mapped through `spec.models`.
- **Ports** (interface first, defined in M3):
  - `LLMClient` stays as is (text/JSON completion).
  - New, separate `ToolCallingLLM` port (messages + tool schemas → tool calls/text), for delegation and tools (ISP).
  - `ModelResolver`: (run context) → `{ client, model, provider }`.
  - Adapters are registered by `spec.type`: `openai-compatible` (OpenAI, Azure, Ollama, OpenRouter, …) and `anthropic`.
- The provider, model and parameters actually used are recorded in `AgentRun.status.provenance.model` (ADR-0012).
- No provider configured means the executor chain falls through to the simulated executor (MVP behavior).

## Consequences
Providers can be switched per squad without touching agents. One more kind to maintain.

## Alternatives considered
Model names in agent definitions: couples prompts to vendors. Environment-only config: not per squad, and not visible in the UI.
