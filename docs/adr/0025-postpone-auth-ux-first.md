# ADR-0025: Postpone auth & squads (v0.4); UX increment first

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** project owner

## Context
The factory now produces real work (agents on Copilot, workspaces, checks, draft PRs). Using it daily exposes UX gaps
(e.g. GFM tables rendered as one paragraph) that hurt more right now than missing multi-user support.

## Decision
- **v0.4 "Auth & squads" is postponed.** It stays planned (ADR-0009, ADR-0011), and the auth-ready rules (rule 9) still apply.
- A **UX increment** takes its slot: readable artifacts and transcripts, then further items re-planned with the owner.
  Each item is listed in `AGENTS.md` §4 with exit criteria, as usual (ADR-0010).

## Consequences
Single-user use stays the norm for now. No auth-related code is removed, and the namespace/principal seams remain.
