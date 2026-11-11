# ADR-0010: MVP-first delivery

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
The target architecture is broad: a full AI-DLC loop, multiple sources, auth, squads, namespaces, and MCP. Building it all
before anyone uses it is risky. We want feedback early.

## Decision
- Deliver an **MVP first**, then improve in small, usable **increments**. The roadmap in `AGENTS.md` §4 is organized
  this way, and each increment ships something usable end to end.
- **MVP = Inception, done for real:**
  input (manual + GitHub sync) → auto-classify → triage (with `code-researcher` via ripgrep) → clarification
  (block / answer / resume) → spec + units → spec-review (human approval) → stop at the state **"Ready for construction"**.
  The dashboard UI covers all of it.
- **In the MVP, stages after spec-review use the simulated executor** (placeholder artifacts, automated gates pass), so the
  full loop is visible but not real.
- **YAGNI with seams:** don't build anything outside the current increment. But when adding a *seam* now is cheap and
  retrofitting it later is expensive (e.g. a `namespace` in store keys, a `Principal` parameter), add the seam and nothing more.
- Every increment is re-planned when it starts. Scope changes go through ADRs.

## Consequences
Early, usable value with a smaller surface to harden. Some interfaces exist before their implementations do.
Out-of-scope work is rejected in review by pointing to this ADR.
The milestone numbering in earlier ADRs (M2–M8) is replaced by the MVP items (M1–M5) and the increments (v0.2–v1.0)
in `AGENTS.md` §4. In particular, ADR-0009's "M7" is now **v0.4**.

## Alternatives considered
Build the full architecture first: slow feedback, high risk of building the wrong thing.
