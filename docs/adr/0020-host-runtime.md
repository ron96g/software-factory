# ADR-0020: Explicit, unsandboxed `host` runtime for local development

- **Status:** Accepted (amends ADR-0019 §5 "no host execution"). The lazy per-item worktree is superseded by the Workspace resource in ADR-0021; the safeguards remain.
- **Date:** 2026-11-11
- **Deciders:** project owner

## Context
No container runtime is usable on the development machine (Podman fails, no Docker daemon, no cluster). To see real
construction work now, agents must run commands locally.

## Decision
- New runtime adapter **`host`**. It runs commands as the current OS user, **without isolation** (`isolation: none`).
- **Explicit opt-in only:** `FACTORY_SANDBOX_RUNTIME=host`. `auto` never selects it.
- Choosing `host` is the operator's consent to **waive the profile's minimum isolation**. The waiver is recorded in each run's
  transcript and provenance, and the UI shows a red "unsandboxed" badge.
- **Safeguards that remain:**
  - **Per-work-item Git worktree** under `web/data/workspaces/<item>` on branch `factory/<item>`. Agents never touch the
    operator's checkout. The worktree persists across runs, so later steps (e.g. the verifier) see earlier changes.
  - **Scrubbed environment:** only `PATH`, `HOME`, `LANG`, `TERM`, `USER`. No factory secrets or tokens.
  - Per-command timeout, output cap, and file tools restricted to paths inside the worktree.
- Known residual risk: commands can still read anything the user can read (e.g. `~/.config`) and use the network.
  Use `host` only on a personal machine with trusted repositories.

## Consequences
Real agent work becomes possible locally. The container/kubernetes adapters remain the target for shared or production use.
