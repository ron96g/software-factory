# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
The plan will evolve, and multiple (AI) agents work on this codebase. Decisions must be traceable and must not be
reversed silently.

## Decision
We use ADRs in `docs/adr/` (template: `0000-template.md`). They are append-only and changed only by superseding them.
`AGENTS.md` is the binding summary and is updated in the same change as each ADR.

## Consequences
Plan changes are slightly slower, and the history stays auditable. Agents must check ADRs before deviating from the plan.
