# software-factory core
- Source of truth for plan/rules: `AGENTS.md` (binding; changes only via ADRs in `docs/adr/`). Read it first; memories do not duplicate it.
- Docs: `docs/ai-dlc-glossary.md` (vocabulary), `docs/architecture.md`, `docs/patterns.md`.
- Definitions as code (repo root): `agents/`, `skills/` (Markdown + YAML frontmatter, body = prompt), `workflows/`, `artifacts/`, `sources/`, `repositories/` (YAML CRs, multi-doc allowed). Validated by `tools/validate.py`.
- App: `web/` (Next.js). Framework-free core in `web/src/core/`: `model/` (pure types), `ports/` (interfaces), implementations per area; wiring only in composition root `web/src/core/factory.ts`. Details: `mem:web/core`.
- Harness: subagent `architecture-reviewer` (`.opencode/agents/`), skills in `.agents/skills/` (interface-first, add-extension, add-resource-kind, controller-pattern).
- Stack/versions: `mem:tech_stack`; commands: `mem:suggested_commands`; code conventions: `mem:conventions`; done-checks: `mem:task_completion`.
- Git repo; runtime data (`data/`, `*.db`), `.venv/`, `node_modules/`, `.serena/cache/` are gitignored.