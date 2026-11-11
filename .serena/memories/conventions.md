# Conventions
- Interface first + ISP: add/extend port in `web/src/core/ports/` before implementing; never widen a port for one impl.
- No `next`/`react`/`@mantine` imports under `web/src/core/`; implementations depend only on ports (constructor/factory injection); concrete classes only in composition root.
- Extension by registry (`Lookup<T>`/`Registrar<T>`), never switch on type/kind in core.
- Status written only by owning controller via `StatusWriter`; humans/sync write spec.
- All diagrams Mermaid; resource names lowercase kebab; ref fields end in `Ref`/`Refs`.
- Comments sparse, explain why.