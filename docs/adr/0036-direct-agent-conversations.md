# ADR-0036: Direct, durable, read-only agent conversations

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0012, ADR-0026, ADR-0034

## Context
An operator investigating a cluster issue wants to talk directly to the support engineer, including fresh MCP
queries and follow-up questions, without first creating a service desk ticket or running a workflow.
Explain conversations must remain grounded in recorded work and must not silently acquire new capabilities.

## Decision
- Extend `Conversation` with purpose `agent-chat`, an agent reference, title and one durable requested turn
  (`id`, text, submitting principal). No new resource kind and no synthetic WorkItem or AgentRun.
- Opt agents in with `spec.chat.allowedTools`: an explicit allowlist of fully qualified MCP tool names, intersected
  with their existing ToolServer permissions. Initially only the support engineer is enabled. This list is a
  human-curated read-only policy; MCP hints and prompt instructions are not authorization.
  Chat has no shell, file writes, artifacts, delegations, knowledge publication, gate or work-item mutation tools.
- Reuse model resolution (including per-agent mappings), MCP sessions and the transcript recorder. Extract shared
  recorded model/tool invocation mechanics from workflow execution, not its WorkItem context or finish protocol.
  Every request, answer and tool interaction is recorded with its turn id. Tool sessions always close.
- Register a turn runner by conversation purpose. The Conversation controller remains the sole owner of its status.
  It opens transcripts and executes queued turns outside reconciliation, with per-conversation serialization.
  Status reports Queued/Running/Waiting/Ready/Failed, handled turn, reason and retry time. Temporary model
  unavailability waits with capped backoff; missing LLMs wait rather than simulating cluster evidence.
- One pending turn per conversation. Submitting the same id/text is idempotent; another request while pending is
  rejected explicitly. Startup requeues persisted turns. A recorded final answer prevents duplicate completion after
  a crash between transcript append and status update. Interrupted read-only tool attempts may be repeated after
  recovery, visibly in the transcript; this is not exactly-once LLM execution. Workers/leases remain future work.
- New chats are standalone resources in the principal's runtime namespace. Existing explain and refinement chats are
  unchanged. MVP chat context is conversation history, agent/skill instructions and approved configured MCP reads.
  Repository browsing still belongs to WorkItems with pinned workspaces; linking their context can be added later.
- UI: Chats list/resume, Start chat from an enabled agent, Markdown answers, expandable tool activity and live
  status updates via existing SSE and active-turn transcript refresh. Requests return after persistence, not after model execution.
- A **human-only app action** creates a WorkItem from reviewed conversation findings, with a typed `conversationRef`,
  bounded redacted context and chosen workflow/repositories. It is idempotent per conversation. It never advances
  gates, alters the chat's ownership, or publishes externally. It is not exposed as an agent tool.

## Consequences
- AGENTS.md X18 records this increment. Conversation and WorkItem types gain optional fields; no migration is needed
  for existing persisted resources.
- A narrow chat command/query port is added before implementation; existing synchronous explanation ports stay intact.
- Cluster access remains subject to operator namespace/CR catalogs and the stdio host opt-in. Tool unavailability
  is recorded and presented honestly; agents must not infer resource absence from an access failure.
- History and tool iterations are bounded. Full token streaming, arbitrary agent execution, new workspace ownership
  and parallel pending messages are not part of this increment.
- Graceful shutdown drains active reconciles and chat turns before closing their store, rather than racing queued
  status writes. Process crashes still use the persisted-turn recovery described above.

## Alternatives considered
- Reuse explain mode: changes its recorded-evidence contract and obscures whether an answer used fresh cluster state.
- Create a hidden WorkItem per chat: invents workflow lifecycle and gate state for an interactive investigation.
- Add a separate chat engine or call an LLM directly from an API route: duplicates tool/recording policy and loses
  pending work when requests disconnect or the app restarts.
