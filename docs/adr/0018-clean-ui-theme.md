# ADR-0018: Clean, professional UI theme (replaces the space theme)

- **Status:** Accepted. Supersedes the "space" theme part of ADR-0007.
- **Date:** 2026-11-11

## Context
The space theme (starfield, glow, nebula gradients) was judged too playful for a tool that teams use daily to make
decisions. The UI should feel like a professional engineering tool.

## Decision
- Mantine stays (ADR-0007). The theme changes to **clean and neutral**:
  - **Light** color scheme by default, with dark available through a header toggle (Mantine `auto`/`light`/`dark`, persisted locally).
  - Neutral gray surfaces, one accent color (**blue/indigo**), no background imagery, gradients, or glow.
  - Typography: Inter for UI text, JetBrains Mono for identifiers and code. Compact, data-dense tables.
  - Status colors only carry meaning: blocked = orange, awaiting approval = yellow, done = teal, failed = red.
  - Subtle borders and small radii. Light alert variants instead of filled blocks.
- Mermaid renders with the theme matching the active color scheme.

## Consequences
Only styling changes. Components and behavior stay the same. ADR-0007's other decisions (Next.js, React, Mantine, SSE,
in-process controllers) remain in force.
