# ADR-0085: Restart with additional context and draft notes

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** project owner
- **Extends:** ADR-0029 (restart), ADR-0032 (additional context), ADR-0071 (inline feedback), ADR-0073 (notes travel with
  planning revisions)

## Context
A human often restarts an item because something changed: a decision made at a gate, a gap found at verify, or a note
left on the spec. For example, `real-kubernetes-cr-backend` reached verify. The human had decided at code review to use
strictly typed CRD schemas and left an unsubmitted note on the spec about the secret namespace. Getting back to
implementation meant three separate actions in the right order:

1. edit the additional context;
2. restart from the stage;
3. submit the draft note, which restarts once more.

If they are done out of order, the re-run misses the context, or the note triggers a second restart. ADR-0073 already
sends draft notes with planning revisions, but not with a plain restart.

## Decision
**Restart → From <stage>** opens a dialog before restarting:

- **Additional context**, prefilled with the item's current context and editable. It is written in the same update as
  `spec.restart`, so the first re-run sees it.
- **Send my N draft inline notes on the re-run stages** (on by default when there are any). The notes on stages from
  the chosen stage onward are marked submitted under the restart's id (one batch, as in ADR-0073) before the restart is
  written, so the producing steps' re-runs receive them once. Notes on earlier stages stay drafts. If the restart can't
  be written, the notes become drafts again.

`WorkItemCommands.restartWorkItem` gets optional `RestartOptions { context?, includeDraftNotes? }`; the restart API
accepts both. Without options a restart behaves as before (MCP `restart_work_item`, "Update pull request", feedback
submission).

## Consequences
- One action restarts with everything the human wants the agents to see. Events record the context change and the
  submitted notes.
- The restart still doesn't change approved plans by itself: restarting from `plan` makes the planner revise, and the
  human reviews the result at the usual gates.
- AGENTS.md: new item **X65**. Glossary: *Restart* updated.

## Alternatives considered
- **Keep separate actions** (edit context, restart, submit notes): error-prone ordering and a possible double restart.
- **Append the context instead of replacing it**: repeated restarts would grow the context with stale decisions. The
  dialog shows the current text, so the human edits it.
- **Always send draft notes**: a human may keep notes as drafts on purpose; the checkbox makes it explicit.
