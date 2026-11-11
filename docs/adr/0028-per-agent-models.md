# ADR-0028: Per-agent models on the ModelProvider

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** project owner
- **Extends:** ADR-0014

## Context
Tiers (`reasoning`, `coding`, `fast`) are too coarse when one agent (e.g. the developer or the reviewer) should use a
specific model. ADR-0014 forbids vendor or model names in agent definitions, and we want to keep that.

## Decision
`ModelProvider.spec.agentModels` is an optional map from agent name to model. `ModelResolver.resolve` takes an optional
`agent`. For the chosen provider, `agentModels[agent]` wins over `models[tier]`. Provider selection itself (namespace,
`default`, secret, `providerRef`) is unchanged. `ResolvedModel.selectedBy` records `agent` or `tier`. The validator
rejects mappings to unknown agents.

## Consequences
- Agent files stay vendor-free, and all model choices live in one place per provider.
- A mapping applies only when that provider is selected; switching providers falls back to tiers.
- Explain-mode responders keep using the `reasoning` tier.

## Alternatives considered
- More or custom tiers: no ADR change, but not fine-grained enough.
- `model.name` in the agent file: simplest, but ties agents to a vendor (would supersede ADR-0014).
