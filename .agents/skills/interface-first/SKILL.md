---
name: interface-first
description: >-
  Mandatory workflow for adding or changing behavior in web/src/core of the software-factory project:
  define/extend a port (interface) first, apply ISP, implement, register in the composition root, test.
---

# Interface First (AGENTS.md rules 1–4, ADR-0006)

## Workflow

1. **Find the port.** Search `web/src/core/ports/` for an existing interface that expresses the capability.
   - If one exists and fits, implement it. Go to step 4.
   - If one *almost* fits, **don't widen it** for one implementation. Go to step 2.
2. **Design the port** (in `web/src/core/ports/<area>.ts`, re-exported from `ports/index.ts`):
   - One responsibility per interface. Split read/write/watch/status, and fetch/publish/read-comments.
   - Name it after the *role* (`ItemFetcher`, `StatusWriter`), not the technology (`GithubClient`).
   - Method arguments and results use model types from `web/src/core/model/` or small DTOs defined beside the port.
   - Add a `Lookup` / `Registrar` pair when there will be several implementations selected by key.
   - Optional capabilities use separate interfaces plus a type guard (see `canFetch` in `ports/integration.ts`).
   - JSDoc only where intent isn't obvious (e.g. "append-only", "side-effect free").
3. **ISP check:** for each consumer, list the methods it actually calls. If a consumer uses fewer than all of them, it
   should depend on a narrower interface. Split if needed.
4. **Implement** in a folder that matches the area, e.g. `web/src/core/store/`, `core/runtime/`, `core/agents/`,
   `core/adapters/<kind>/`. Rules:
   - Depend on ports in constructors (constructor injection). Never import another implementation.
   - No `next`, `react`, or `@mantine/*` imports anywhere under `core/`.
   - No `switch (type)` over extension keys. Use a registry.
5. **Register / wire** only in the composition root (`web/src/core/factory.ts`). That is the one file that knows
   concrete classes.
6. **Test** with `node:test` against the port, using in-memory fakes for the dependencies (`*.test.ts` beside the implementation).
7. **Verify:** `cd web && npx tsc --noEmit`, the tests, and `.venv/bin/python tools/validate.py` if definitions changed.
8. **Document:** if the change introduces a new concept, add it to the glossary. If it changes a decision, write an ADR.

## Checklist (copy into your summary)
- [ ] Port exists or was added before the implementation
- [ ] No existing port widened for a single implementation
- [ ] Consumers depend on the narrowest port
- [ ] No framework imports in core; wiring only in the composition root
- [ ] No type switches; registry used
- [ ] Tests against the port
- [ ] tsc / tests / validate pass
