# Tech stack
- Node v26, npm 11. `web/`: Next.js 16 (App Router), React 19, Mantine 9 (+ postcss-preset-mantine), @tabler/icons-react, `yaml`, react-markdown, TypeScript 7 (strict, moduleResolution bundler, path alias `@/*` → `web/src/*`).
- Persistence plan: SQLite via built-in `node:sqlite` (no native deps); Postgres later.
- Tests: built-in `node:test` (no extra framework).
- Python tooling: `.venv/` at repo root with pyyaml + jsonschema (system python lacks pyyaml).
- Code search: ripgrep (`rg` available).