# ADR-0071: Inline feedback on artifacts (select → ask or note → submit as one batch)

- **Status:** Accepted
- **Amended by:** ADR-0073 (planning revisions carry draft notes)
- **Date:** 2026-11-19
- **Related:** ADR-0056 (proposed owner-led peer feedback; this is its single-user, unauthenticated precursor)
- **Deciders:** project owner
- **Extends:** ADR-0012 (explain conversations), ADR-0027 (gates), ADR-0029 (restart)

## Context
Humans review artifacts paragraph by paragraph, mostly at the spec-review gate. Today they can only reject the whole
gate with one free-text comment, which makes them restate *where* something is wrong. Asking about a specific passage
means opening the run and typing the context into the "Ask this agent" chat. Also, a re-run of the producing step
usually doesn't see its earlier output (e.g. `write-spec` has `triage-decision` as input, not `spec`), so a comment
like "change this paragraph" has nothing to refer to.

## Decision
- **Select → popover.** Selecting text in an artifact opens a small popover with two modes:
  - **Ask (read-only):** the question is sent with the passage quoted (`> …`) to the producing run's `explain`
    conversation (ADR-0012); the newest one is continued, so it also appears in the run's "Ask this agent" chat. The
    explain rules tell the agent to answer about the quoted passage. Nothing changes.
  - **Feedback:** creates a `Feedback` draft.
- **`InlineFeedback` (runtime kind, owned by the WorkItem; named apart from `RetrospectiveFeedback`, ADR-0041).** `spec`: `workItemRef`, `targetRef` (the Artifact version the
  human read), `producedBy` (run, agent, stage, step), `quote`, `comment`, `author`, `submitted?` (`id`, `at`, `by`).
  Humans write it; there is no `status` and no controller: the state is derived (`draft` without `submitted`,
  `addressed` once a succeeded, non-replay run lists it in `provenance.feedback` and that run's effect still counts,
  else `submitted`). A run superseded by a restart no longer counts (its output is gone), unless a newer submitted note
  annotates exactly that run's output: the version attached to the newer note already contains the change. Only drafts
  can be edited or deleted. Feedback on replay output is refused (replays never advance the workflow).
- **Submit as one batch** (`FeedbackActions.submitFeedback`). All drafts of the item are marked submitted first, then:
  - if the item waits at a human gate whose `onReject.next` is the earliest producing stage of the batch or earlier,
    the gate is **rejected** (comment: "Changes requested through N inline feedback notes"), so the decision stays on
    record (X7);
  - otherwise the item **restarts** from the earliest producing stage (ADR-0029).
  If the reject/restart fails (e.g. the gate was decided meanwhile), the batch is unmarked again and stays drafts.
  The UI shows what Submit will do before the click (`WorkItemDetail.feedbackPlan`). A `FeedbackSubmitted` event
  records it.
- **Delivery.** The context factory gives the next run of the producing stage/step all submitted notes it hasn't
  received yet (`ExecutionContext.feedback`, grouped per artifact). The prompt contains each quote + comment **and the
  version the human read**, with the instruction to revise it, apply every note and keep the rest. The run records the
  names in `provenance.feedback`, so every note reaches one successful run whose effect counts; replays get the
  original's notes. Notes are given oldest first, and later notes win where they conflict.
- The item-level conversation (ADR-0026) sees feedback as human input.

## Consequences
- Precise, batched review feedback at gates and after them, without restating context; questions about a passage
  are one step.
- A failed or superseded run doesn't consume notes: the next effective run gets them again.
- Narrow race: a run of the producing step that builds its context between marking and a failed reject/restart can
  receive notes that are then unmarked; they stay drafts and, once submitted again, count as received by that run.
- Feedback on a later stage's artifact at an earlier gate (rare) restarts from that stage instead of rejecting.
- Quotes are located in the rendered text for highlighting; if an artifact is re-rendered differently the note stays
  valid, only the highlight is missing.
- Not exposed via MCP yet (seam: `FeedbackActions`).
- AGENTS.md §1 (runtime kinds) and §4 (X51) updated.

## Alternatives considered
- **Browser-only drafts, folded into the reject comment:** no new kind, but drafts are lost on reload, invisible to
  teammates, and the agent gets unstructured text without the annotated version.
- **Only at gates:** simpler, but feedback on an already approved spec (e.g. during construction) would need a manual
  restart plus retyping.
- **A new conversation per selection:** more threads to find later; the run's existing explain conversation already
  is the place to ask the producing agent.
- **A Feedback controller writing `status`:** would duplicate what run provenance already records.
