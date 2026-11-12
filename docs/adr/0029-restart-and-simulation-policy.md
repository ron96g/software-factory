# ADR-0029: Restart work items; optionally wait instead of simulating

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** project owner
- **Extends:** ADR-0005, ADR-0010, ADR-0012, ADR-0019

## Context
Without an LLM (or a sandbox), agents fall back to the simulated executor and produce placeholder artifacts. That keeps
the loop demonstrable (ADR-0010), but in real use an item imported before a key was configured ends up full of
placeholders, and there is no way to run it again: replays (ADR-0012) never advance the workflow, and deleting the
item loses its history (and manual items can't be re-imported).

## Decision
1. **Restart.** Humans request a restart by writing `WorkItem.spec.restart = { id, stage?, requestedBy }`
   (`WorkItemCommands.restartWorkItem`, UI "Restart" menu). The WorkItem controller handles each `id` once:
   it labels AgentRuns and Artifacts of the restarted stage and every later stage `factory.ai-dlc.io/superseded`,
   re-enters the stage (default: the first) with a new `round` (retry budgets reset), and records
   `status.restartHandled`. This also works for `Done`, `Closed` and `Failed` items.
   - Superseded artifacts are never agent input again; neither is any output of a superseded run, even one that
     finishes after the restart (level-triggered). Superseded runs don't count as gate evidence (ADR-0027).
     Faithful replays of old runs still see their original inputs.
   - The `superseded` label is metadata written by the WorkItem controller (the owner of runs and artifacts); spec and
     status ownership are unchanged.
   - Superseded runs that haven't started are cancelled (`Failed`, "superseded by a restart"); running ones finish.
   - Human input (answered clarifications, gate decisions) stays agent input. Open clarifications/approvals of the old
     round stay as history but can no longer be answered or decided (the API accepts only the item's current
     `blockedBy`), and are no longer polled at the source.
2. **Simulation policy.** `FACTORY_SIMULATION=allow` (default, unchanged behaviour) or `wait`. With `wait`, an
   `ExecutionGate` port lets the AgentRun controller check, before executing, whether a real executor (tool loop, LLM,
   skill handler) can take the run, judged on a side-effect free context preview (`ExecutionContextPreviewer`: no
   transcript, no context providers). If not, the run stays `Pending` with the reason, a `Waiting` event is recorded
   once, and it is retried every 30 s. System health reports the policy.

## Consequences
- An item can be re-run after configuration changes, prompt/model changes, or a bad round, keeping its history.
- `wait` gives "real output or nothing"; deterministic skill handlers still run.
- Restarting does not reset the item's workspace: code changes from earlier rounds stay in the worktree, and a
  `Failed` workspace stays failed (delete and re-create the item in that case).
- The default stays `allow`, so demos and tests without keys still run end to end (AGENTS.md rule 18 amended).

## Alternatives considered
- Delete and re-sync: loses history, impossible for manual items.
- `wait` as the default: changes the documented MVP behaviour and needs keys for every demo; kept opt-in.
- Deleting superseded artifacts instead of labelling them: loses the audit trail (ADR-0012).
