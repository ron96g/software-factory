# ADR-0076: The product owner drafts follow-up tickets

- **Status:** Accepted
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Amends:** ADR-0068 §1 (ticket body rendered from the evidence snapshot)

## Context
ADR-0068 renders a tracker follow-up's body from the reviewed evidence snapshot: the human's instructions, the origin
links, and then the **whole** snapshot (agent summaries, clarifications, gate history, every artifact). The first real
ticket created this way (DHEI-21987, from SDDHEI-11446) has a 20,000-character description. The team can't plan from
it: the problem, the goal and what "done" means are buried under research notes and run summaries.

The snapshot doesn't need to be in the ticket. **Start implementation** (ADR-0068 §4) re-derives the same snapshot from
the origin item, and the ticket links to that item. The ticket should be what a team plans from: a short problem
statement, a goal and testable acceptance criteria.

## Decision

### 1. The product owner drafts, the human reviews and creates
In the follow-up dialog's **Tracker ticket** destination, **Draft with product owner** sends the reviewed preview
(same revision as ADR-0068: instructions + evidence snapshot) and the target's ticket fields to the `product-owner`
agent with the `ticket-writing` skill. The agent returns a title and a Markdown body. The dialog puts them into editable
fields. **Redraft** sends the current (possibly edited) draft plus the human's feedback.

- The draft is only a proposal. **Create** stays the approval (rule 8). The approved content is exactly the title and
  body the human saw, bound by ADR-0066's content hash and the preview revision.
- `NewFollowUpTicketInput.body` carries the reviewed body. The server checks the preview revision as before.
- The agent never chooses the tracker, the project or the fields, and drafting writes nothing outside the factory.

### 2. Ticket structure (`ticket-writing` skill)
Problem, user story, one SMART goal, numbered **Given/When/Then** acceptance criteria (every human MUST maps to at
least one criterion), scope and out of scope, and at most five implementation notes with `repo:path:line` citations.
It is short (about 400 words), has no factory jargon or run names, and uses only formatting the Jira and GitHub
renderers support (no tables or nested lists). The skill is a definition in `skills/`, so teams can change the format
without a code change.

### 3. No evidence dump; origin links are appended by the server
The body no longer contains the snapshot. The server always appends the **Origin** section (origin ticket URL and
factory work item link) after the reviewed body, so the agent or an edit can't drop the provenance. Start
implementation still carries the full snapshot (unchanged).

### 4. Recorded, side-effect free
Each draft is recorded in a `Conversation` with purpose `draft-ticket`, owned by the origin work item. It records the
system prompt, the request (instructions, evidence, feedback) and the answer with the model (rule 14). Redrafts within
one dialog append to the same conversation. The created `IssueProposal` records it in
`spec.provenance.draftedBy: { agent, conversation }`.

### 5. Port and fallback
`FollowUpTicketDrafter` port (`web/src/core/ports/work-item-followups.ts`) with one implementation,
`ProductOwnerTicketDrafter`. The agent and skill names are wired in the composition root. Without an LLM the drafter
returns a short deterministic template (instructions + origin description) with a visible reason, and the human edits
it. A model quota error (ADR-0031) is shown in the dialog. The dialog is interactive, so there is no durable wait.

## Consequences
- Created tickets are short and plannable. The investigation stays one click away (factory link) and still reaches the
  implementation item.
- API callers that send no `body` get the deterministic template instead of the evidence dump.
- New conversation purpose `draft-ticket`. It has no chat responder: drafts are produced only through the dialog.
- `markdownToWiki` / `markdownToAdf` limits (no tables, nested lists) are now constraints in the skill.
- AGENTS.md: new item **X56**. Glossary: *Ticket draft*.

## Alternatives considered
- **Keep the snapshot as an appendix**: still long, and the team reads the ticket in Jira, not the appendix. The
  factory link and Start implementation already cover traceability.
- **Rewrite automatically at Create**: the human would approve text they never saw (rule 8).
- **A chat with the product owner to iterate** (like `refine-knowledge`): more UI for little gain. Draft + edit +
  redraft-with-feedback covers it. A chat can be added later on the same conversation.
- **A workflow stage / AgentRun**: an AgentRun belongs to a workflow step and advances the item's workflow, but
  drafting is an interactive helper outside the origin's workflow.
- **Add `ticket-writing` to the product owner's `skillRefs`**: every workflow run of the product owner would carry
  the skill in its prompt. The drafter resolves it explicitly instead.
