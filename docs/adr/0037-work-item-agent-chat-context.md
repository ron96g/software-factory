# ADR-0037: Work-item context in direct agent chats

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0026, ADR-0036

## Context
An operator wants to investigate an existing WorkItem with a chosen agent in a chat interface, using both the
item's recorded evidence and the agent's read-only MCP tools. Existing explanation chats deliberately use only
recorded evidence; starting a workflow run would introduce stage progression and gate semantics.

## Decision
- Reuse `Conversation.purpose: agent-chat` with an optional existing `workItemRef`. No new resource kind, synthetic
  AgentRun, workspace or workflow execution. Only explicitly chat-enabled agents are offered.
- Start from a WorkItem's **Chat with agent** action, or select an optional WorkItem on the chat list.
  The reference is validated in the caller's runtime namespace and is fixed for the lifetime of the chat.
- Load the current WorkItem description, additional context, status, runs, artifacts, clarifications, approvals
  and key events before each turn. Reuse the bounded evidence digest used by item explanation through a narrow
  record-reader port. The transcript records the redacted context and resource versions actually read for each
  attempt. These reads are not a transactional snapshot; the workflow may progress independently.
- Treat the item record as evidence, not instructions. Historical workflow results are distinct from fresh MCP
  observations; the agent must identify which supports its answer. Existing chat tool allowlists remain unchanged.
  Linking an item supplies evidence, not its workspace or additional execution permissions.
- Context chats remain standalone and labelled by WorkItem, without owner cascade. Resume them from Chats or the
  item's chat action. If the item disappears, a new turn fails visibly; old transcripts remain readable.
- A linked chat opens its existing WorkItem instead of offering **Create work item**. The app rejects conversion
  of these chats to prevent accidental duplicate items. It does not write findings back, advance stages, answer
  clarifications or decide gates. Existing standalone handoff and explanation behavior stay unchanged.

## Consequences
- AGENTS.md X19 records the increment. No persisted model migration is needed; `workItemRef` already exists.
- Each turn sees newly available evidence, while the transcript preserves what earlier answers used. The digest
  can omit content on large items and marks truncation explicitly.
- Repository file browsing, workflow mutations, arbitrary agents without chat opt-in, and writing findings back
  to the existing item remain outside this increment.

## Alternatives considered
- Add tools to `explain-item`: breaks its recorded-evidence-only contract.
- Start a workflow AgentRun and expose it as chat: couples an interactive conversation to workflow advancement.
- Copy the entire item into the initial message: becomes stale and loses typed provenance and namespace checks.
