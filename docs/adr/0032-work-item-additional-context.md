# ADR-0032: Human-provided additional context on work items

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** project owner
- **Extends:** ADR-0002

## Context
Synced tickets (e.g. service desk requests) often lack facts the internal team already knows: the environment, the
customer's setup, what was already tried. Agents then block with clarification questions, and the team answers what
it could have said up front. The ticket description belongs to the source (sync overwrites it), so it can't hold this.

## Decision
- `WorkItem.spec.context` (optional Markdown, max 20,000 characters) holds additional context from humans. It is set
  in the "New item" form or on the item page (`WorkItemCommands.updateWorkItemContext`, recorded as a
  `ContextUpdated` event) and is never written by sync, which updates only title and description.
- Every agent prompt includes it as "Additional context from the team", right after the description. Code and
  knowledge searches use it for their terms, and the item-level chat sees it.
- Editing it doesn't re-run steps that already finished; agents use it from their next run (or a Restart, ADR-0029).

## Consequences
- Fewer clarification round trips; the team can prime agents before they start.
- Replays use the item's current context, not the one the original run saw (the context is not pinned in provenance).

## Alternatives considered
- Answering clarifications only: works, but costs a round trip per question and blocks the item.
- Editing the description: overwritten by the next sync, and mixes the requester's text with internal notes.
