# ADR-0017: MVP tools are supplied as context; LLM tool-call loop deferred

- **Status:** Accepted (clarifies ADR-0014 and ADR-0016)
- **Date:** 2026-11-11

## Context
ADR-0014 introduced a `ToolCallingLLM` port, and ADR-0016 a read-only tool registry. The architecture review of M1–M4 found
that no LLM path actually calls tools. Agents like `code-researcher` declare `code-search`, `git-read`, and `filesystem-read`.

## Decision
- **MVP:** read-only capabilities are delivered as **context providers** that run *before* the LLM call (e.g. the
  `code-search` provider runs ripgrep and records `tool-call` / `tool-result` entries in the run transcript).
  The LLM does not invoke tools itself.
- The tool registry (`AgentToolInfo`) acts as an **allowlist**: the LLM executor only runs agents whose declared tools are all
  registered read-only tools. Other agents fall through to the simulated executor (ADR-0016).
- The `ToolCallingLLM` **port stays**, as a seam. Adapter implementations were removed until there is a consumer.
- **Delegation as tool calls** (`Delegator`, `ask_code_researcher(...)`) and the agentic tool loop, with every call and
  result recorded, arrive with **v0.5 (tool servers / MCP)**. In the MVP, delegation is modeled as a preceding workflow step
  (`research-impact` before `triage-signal`).

## Consequences
Simple, deterministic, fully recorded research. The LLM can't refine its searches on its own until v0.5.
