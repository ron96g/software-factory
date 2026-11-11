# ADR-0006: Interface-first, ISP, ports & adapters, registries

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
The factory must be extensible: new sources, gates, checks, LLMs, search backends, and kinds.

## Decision
- Define interfaces (ports) in `web/src/core/ports/` before any implementation.
- Follow the Interface Segregation Principle: small, role-specific interfaces. Connector capabilities are separate
  (`ItemFetcher`, `CommentPublisher`, `CommentReader`) and detected with type guards.
- Use hexagonal architecture: `core` has no framework imports, and wiring happens only in the composition root.
- Extensions are added through registries (`Lookup<T>` / `Registrar<T>`), not through `switch` statements in core.
- Agent execution uses a Chain of Responsibility: LLM executor → built-in skill handlers → simulated fallback.

## Consequences
Easy to extend and test, at the cost of more files and indirection.
