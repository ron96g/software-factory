# ADR-0038: Explicit completion of agent chat turns

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0036

## Context
A direct chat returned "I'll start by discovering which resource types I'm allowed to query" without making
a tool call. All configured tools were available. Treating every text-only model response as a final answer
incorrectly marked the turn Ready, so no investigation followed. Stronger wording can encourage tool use but
cannot distinguish an interim announcement from an intentional completed answer.

## Decision
- Direct chats offer a reserved, internal `respond` protocol tool in addition to their existing curated MCP tools.
  Its non-empty `message` is the final Markdown answer or a question for the human. It grants no resource access
  and is not an MCP server tool, registry extension, workflow `finish` call or mutation capability.
- Keep the provider's normal automatic tool selection. Completion is enforced locally, not through provider-specific
  forcing: the configured Copilot model rejects required tool selection. Existing model adapter contracts stay unchanged.
- A text-only response is recorded as interim, followed by a recorded continuation instruction, within the existing
  20-step budget. Exhaustion fails visibly instead of claiming success. No natural-language heuristics decide completion.
- Accept `respond` only as the sole tool call with a non-empty string message. Mixed or invalid completion calls
  receive a recorded protocol error; actual read-only calls remain subject to the same allowlist.
- Only the validated final message receives the transcript's completion marker. Recovery, history selection,
  controller status ownership and human gates stay unchanged. Existing completed transcripts remain readable.

## Consequences
- AGENTS.md X18 and the direct-chat documentation describe explicit completion. No resource migration is needed.
- Announcements no longer stop execution or become false recovery checkpoints. Models that ignore the completion
  protocol cannot silently finish a turn; they eventually produce a visible bounded failure.
- The transcript includes the internal completion call; the UI still displays its answer as ordinary Markdown.
- This protocol confirms the model intentionally ended the turn, not that its conclusions are correct. A model
  can still give an inadequate final answer, which remains subject to human review.

## Alternatives considered
- Prompt-only encouragement: useful but does not prevent premature completion.
- Required provider tool selection: unsupported by the configured model; local protocol validation is portable.
- Detect promises with regular expressions: brittle across languages, phrasing and legitimate quoted evidence.
- Force a CR query for every message: unnecessary for summaries and human questions, and couples chat to one tool type.
- Reuse workflow `finish`: imports artifact/outcome semantics into conversations that do not execute workflows.
