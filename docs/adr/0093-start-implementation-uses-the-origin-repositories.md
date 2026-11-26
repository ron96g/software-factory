# ADR-0093: Start implementation uses the origin item's repositories

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** project owner
- **Amends:** ADR-0068 §4 (defaults of Start implementation), ADR-0084 (implementation item starts from the research)

## Context
ADR-0068 §4 takes the workflow and repositories of a started implementation from the target Source's `defaults`.
Those defaults describe items *synced* from that tracker, not the code a follow-up ticket was researched against.
In practice, a `story-refinement` item researched on `controlplane` published DHEI-22023 to `jira-main`. "Start
implementation" sent no input, so the new item got `jira-main`'s default repository `software-factory`. That
repository is unrelated, and the planner started on the wrong code. A sync that imports the ticket first had the
same gap, because admission fills missing repositories from the Source defaults.

## Decision
1. **Repositories come from the origin.** The repositories of a started implementation are resolved in this order:
   - the human's explicit choice
   - the origin work item's `spec.repositoryRefs`
   - the target Source's defaults, only when the origin has none

   The workflow still defaults to the target Source's (`factory-plan`). The origin's workflow (e.g.
   `story-refinement`, `servicedesk`) is not an implementation workflow.
2. **No silent empty choice.** If none of the three yields a repository, Start implementation is refused (`Conflict`).
3. **Sync applies the same rule.** `FollowUpOrigin` carries the origin's repositories. A ticket imported by sync
   before anyone starts it gets them at creation. An existing item's repositories are never changed by sync, because
   its workspace is already pinned.
4. **The human sees the choice.** The UI's Start implementation opens an inline form: the workflow (default: the
   ticket Source's) and the repositories, prefilled from the origin item. Start stays disabled without a repository.

## Consequences
- Follow-up and story tickets for any repository start on the code they were researched against.
- Items created before this change keep their repositories. A wrong item is fixed by deleting it and starting it
  again; the name is derived from the ticket, so no ticket is duplicated.
- No new kind or port. `StartImplementationInput` already had the fields, and `FollowUpOrigin` gains an optional
  field.
