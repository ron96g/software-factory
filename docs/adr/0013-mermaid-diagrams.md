# ADR-0013: All diagrams are Mermaid

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
ASCII and box-drawing diagrams are hard to maintain, render inconsistently, and can't be processed by tools.
The UI renders Markdown (artifacts, docs) and can render Mermaid there too.

## Decision
- Every diagram in docs, ADRs, READMEs, and **agent-generated artifacts** is a fenced ` ```mermaid ` block
  (flowchart, stateDiagram-v2, sequenceDiagram, classDiagram, erDiagram, …).
- Not covered: directory trees, inline prose sequences (`a → b → c`), and short code comments.
- Existing ASCII diagrams have been converted (README, architecture, glossary, patterns).
- Skills that produce diagrams (e.g. `domain-driven-design`) instruct agents to output Mermaid.
- The UI's Markdown renderer must support Mermaid (part of M5).

## Consequences
Diagrams render in GitHub and the UI, and diffs stay readable. Very complex layouts can be harder to express.
