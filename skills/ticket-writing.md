---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: ticket-writing
spec:
  description: Write a short, plannable tracker ticket (SMART goal, Given/When/Then acceptance criteria) from investigation evidence (ADR-0076, ADR-0077).
---

# Ticket Writing

You turn an investigation (research notes, analyses, human clarifications) into a ticket a team can read and plan
from in two minutes. Write for the developers and the product owner who will pick it up, not for the factory.

## Structure
Use these sections in this order. Leave out a section only if you have nothing true to put in it.

1. `## Problem`: 2 to 4 sentences. What is wrong or missing, who is affected, and the impact. Plain language.
2. `## User story`: one line. *As a* role, *I want* capability, *so that* benefit.
3. `## Goal`: one SMART goal, as a short bullet list with these labels:
   - **Specific:** what changes, and where.
   - **Measurable:** how we can tell it is done (a check, a test, an observable behaviour).
   - **Achievable:** why it fits one ticket. If it doesn't, say what to split off.
   - **Relevant:** why it matters now (link it to the problem).
   - **Time-bound:** a date or release only if the evidence names one. Otherwise write "Set in planning". Never
     invent a deadline.
4. `## Acceptance criteria`: a numbered list of 3 to 7 items. Each one is
   `**Given** <context>, **when** <action>, **then** <observable result>.`
   - Every criterion is testable by someone who didn't read the investigation.
   - Every human instruction with MUST, MUST NOT or "always" maps to at least one criterion.
   - Include at least one regression or negative case (what must keep working, or must not happen).
5. `## Scope`: two bullets, `In scope:` and `Out of scope:`.
6. `## Notes for implementation`: at most 5 bullets: verified findings with `repo:path:line` citations, risks, and
   open questions. Mark a hypothesis as a hypothesis.

## Rules
- Short: about 400 words, not counting citations. Don't copy the evidence. Summarise it and cite it.
- Human instructions and clarification answers are requirements. Never contradict them or weaken them.
- Only facts from the evidence. No guesses presented as facts, no secrets, and no customer names, contact details or
  other personal data.
- No factory jargon: no agent names, run names, stages, gates, artifact names or "work item".
- Formatting the trackers render: headings, flat bullet and numbered lists, bold, inline code, links, and fenced code
  blocks. No tables, no nested lists, no task-list checkboxes, and no HTML.
- The title is imperative and specific, at most 80 characters, with no prefix like "Follow-up:" or "Bug:".
- Don't add links to the origin ticket or the factory. They are appended automatically.

## Output in a workflow
When your step outputs a `ticket-draft` artifact (the `story-refinement` workflow, ADR-0077), its content is JSON:
`{"title": "<title>", "body": "<Markdown body with the sections above>"}`. A human reviews exactly this text before it
is published. If a human rejected an earlier draft, address every point of the reason and the inline notes.
