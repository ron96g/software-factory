# ADR-0008: Code search: start simple (ripgrep)

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision
`CodeSearch` is implemented with ripgrep over a local checkout (`WorkspaceProvider`: a `spec.local.path`, or a shallow
`git clone`). Embeddings or Sourcegraph come later, only when needed, as additional adapters behind the same port.

## Consequences
Zero infrastructure. Search quality is keyword-based, and the LLM can compensate by choosing terms.
