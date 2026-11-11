# Done checks
1. `cd web && npx tsc --noEmit -p .`
2. `.venv/bin/python tools/validate.py` (if definitions changed)
3. Tests (`node --test`, once configured)
4. Update docs/glossary/ADR + milestone status in `AGENTS.md` §4
5. Run subagent `architecture-reviewer` when closing a §4 item.