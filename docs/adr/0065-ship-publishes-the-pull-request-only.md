# ADR-0065: Ship publishes the pull request only

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** project owner
- **Amends:** ADR-0003 (the loop ends at ship until v0.6)

## Context
The `ship` stage of the factory workflows did two things: it published the change (push `factory/<item>`, open a
draft PR; ADR-0023, ADR-0053) and it ran a `release` step. That step's `release-manager` agent declares the tools
`shell`, `git` and `kubectl`, which no sandbox provides. With `FACTORY_SIMULATION=wait` (ADR-0029) every item therefore
waited forever at `ship/release`, after its PR had been opened. The following `monitor` stage (`sre`) consumed the
`release` artifact that only that step produced. Releasing and monitoring for real are planned for v0.6 (Operations);
until then both stages only produced placeholders.

## Decision
1. `ship` has no agent steps. Entering it publishes the pull request (unchanged), and its `human-approval` gate
   (ops lead) confirms the published PR; reject still returns to `implement` with the reason. A delivery that failed
   for good stays visible but does not block the gate (unchanged, ADR-0023): the stage view says the PR could not be
   delivered, and the human decides with that in front of them.
2. `monitor` and the workflow-level `loop` (monitor → classify) are removed from `factory-loop`, `factory-plan`,
   `factory-planned` and `factory-verified`. An item is `Done` once its PR is confirmed.
3. The `release-manager` agent, the `release-management` and `observability` skills, the `sre` agent and the
   `release` and `signal` artifact types stay defined for v0.6. `monitoring-feedback` stays an input source.

## Consequences
- Items no longer stall after their PR is opened; the human gate stays (AGENTS.md rule 8).
- The factory loop in AGENTS.md §1 and the glossary ends at ship; "repeat" comes back with v0.6, which re-adds release
  and monitor stages with registered tools.
- Workflow definitions change, so in-flight items re-confirm their plan once (ADR-0054).
- AGENTS.md: §1 loop, X45.

## Alternatives considered
- **Give release-manager registered tools.** Produces a release plan nobody executes; ship still waits on an agent.
- **Allow simulation for release-manager.** A placeholder `release` artifact feeding a placeholder `monitor`.
- **Drop the ship gate too.** Rejected by the project owner: a human confirms the published PR.
