# ADR-0026: Item-level conversations (conversation purposes, responder registry)

- **Status:** Accepted (extends ADR-0012)
- **Date:** 2026-11-11

## Context
Explain-mode chats (ADR-0012) are tied to one agent run. Users want to ask about the whole work item, e.g. "What did the
product owner do?" or "Why did it go back to implement?", without finding and opening the right run first.

## Decision
- `Conversation.spec.purpose` selects the behaviour: `explain` (one run; `agentRunRef`/`agentRef` required) or
  `explain-item` (the whole item; no run).
- Responders are **registered by purpose** (`Lookup<ConversationResponder>`). New purposes are added by registration, not by
  switches (rule 4).
- The `explain-item` responder builds a bounded **digest** of the item: every run (agent, stage/step, round, executor/model,
  summary, outcome, questions), artifacts (truncated), human input and key events. It answers with attribution
  ("product-owner, spec/write-spec, round 3"). It's read-only and records to the conversation transcript (rule 14). Without
  an LLM, it lists the runs of the agents named in the question.
- UI: an "Ask about this item" chat with suggested questions. The run-level "Ask this agent" chat stays.

## Consequences
One place to understand an item. Very long items are truncated in the digest (60k characters); the answer says when something
is outside the record.
