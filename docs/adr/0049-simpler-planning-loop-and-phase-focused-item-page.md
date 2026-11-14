# ADR-0049: Simpler planning loop and a phase-focused item page

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Extends:** ADR-0042, ADR-0045/0046, ADR-0047, ADR-0048

## Context
Running one real work item through the planned workflow surfaced compounding friction. Five sequential planning
agents rerun on every change (about four minutes). Strict, correct structure validation of agent output only ran at
the plan gate, after the whole chain, and then stopped the item for a human who could only request another full
regeneration. The item page showed every panel of every phase at once: the editable plan workspace with disabled
controls during construction, misleading approval warnings, verification policy and check logs at top level.
The owner judged both the process and the UI too complicated.

## Decision
### Fix malformed output where it is produced
- New narrow port `ArtifactCheck` (artifact type → deterministic structure check), registered in a registry in the
  composition root: `validation-plan` (content and policy validation without approval or planning bindings) and
  `implementation-plan` (planning document parsing).
- When a step succeeds, the WorkItem controller checks its output artifacts. A problem reruns **only that step** in a
  new round (at most two times per step), records an `OutputRejected` event, and the rerun agent receives the exact
  reason through the `output-feedback` context provider. After the budget, the existing gate handling applies
  unchanged, so nothing that was previously enforced is weakened.

### Show what matters for the current phase
- Pending human decisions (clarification, approval) come first. During inception the plan workspace is the main view;
  from construction on, Unit progress is the main view and the approved plan is a compact summary with the full text
  on demand.
- Controls that cannot be used now are hidden rather than shown disabled. The plan approval card appears only while a
  plan approval is pending; reject/defer move into a small "Close proposal…" menu; the revision hash is a tooltip.
- Verification contract and check evidence move into the collapsed details section; secondary header actions
  (agent chat, follow-up) move into a "More" menu. All information remains reachable.

## Consequences
- Format mistakes cost one step rerun instead of a full planning chain plus a human stop.
- The item page reads top-down: what needs me, what is happening, details on demand.
- Follow-ups, not decided here: rerun only affected planning stages after answers; merge planning agents into one
  planner run plus one review (workflow change, needs its own ADR); let humans mark stale recorded answers superseded.

## Alternatives considered
- Loosen validation: hides real defects; fixing at the source keeps the guarantees.
- More automatic review rounds: slower and still ends at a human stop.
- A separate "simple mode" UI: two UIs to maintain; phase-aware layout serves both novices and experts.
