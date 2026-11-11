# ADR-0007: Tech stack: Next.js, React, Mantine (space theme), TypeScript

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision
- Next.js (App Router), React, and TypeScript in `web/`. The API is Next.js route handlers on top of `core`.
- UI library: Mantine (dark color scheme, custom "space" theme: deep-space background, starfield, nebula
  violet/cyan accents).
- Live updates use Server-Sent Events backed by `ResourceWatcher`.
- Controllers run in-process, started from Next.js `instrumentation.ts` (single process until M8).

## Consequences
One deployable for now. Core stays framework-free (ADR-0006), so the control plane can be split out later.
