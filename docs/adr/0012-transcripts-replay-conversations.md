# ADR-0012: Agent transcripts, replay & follow-up conversations

- **Status:** Accepted (part of the MVP)
- **Date:** 2026-11-11

## Context
Humans must be able to understand and question what agents did, e.g. *"Triager, why did you mark this as needs-info?"*.
To do that, every agent interaction for a WorkItem must be recorded, inspectable, replayable, and open to follow-up questions.
Transcripts that were never recorded can't be recovered later, so this belongs in the MVP (ADR-0010: expensive to retrofit).

## Decision

### 1. Transcripts (recorded for every AgentRun)
- Every LLM or skill-handler interaction is appended to a **Transcript**, an append-only, ordered log of messages:
  `system | user | assistant | tool-call | tool-result | note`. Each message has a timestamp, an author (agent, human
  principal, or system), and optional token or latency metadata.
- Transcripts are **not** stored inside the resource document. They go into a dedicated append-only table, accessed
  through the `TranscriptWriter` / `TranscriptReader` ports. `AgentRun.status.transcriptRef` points to the transcript.
- Delegated runs (e.g. code-researcher) have their own transcript, linked through `parentRunRef`. The UI shows them as a tree.

### 2. Reproducibility snapshot
`AgentRun.status.provenance` records what is needed to explain or re-run the run: the executor, the model and its
parameters, the definitions' `resourceVersion` or Git commit (agent, skills, workflow), the input artifact versions,
the clarification answers used, and a prompt hash.

### 3. Replay (two modes)
- **Inspect:** step through the recorded transcript exactly as it happened. This is read-only and always available.
- **Re-run:** create a *new* AgentRun from the same provenance and inputs (optionally with a different model or definition
  version) and diff the results. It never overwrites the original run.

### 4. Follow-up conversations ("ask the agent why")
- New runtime kind **`Conversation`**: `spec { workItemRef, agentRunRef, agentRef, purpose: explain }`, owned by the WorkItem.
  Messages are stored as a transcript.
- The agent is seeded with the **original run's transcript and provenance**, plus an instruction to explain and justify its
  reasoning without making changes.
- **Explain mode is side-effect free:** it never changes the WorkItem, artifacts, or gates. If the human disagrees, they act
  through the normal flow (answer, reject, or re-run). A future "steer" mode would need its own ADR.
- Human messages carry the author (`Principal`, auth-ready per ADR-0009). Until v0.4 this is `anonymous`.

### 5. UI
On the WorkItem detail page: a **timeline of AgentRuns**, a **transcript viewer** (collapsible tool calls, delegation tree,
provenance panel), and an **"Ask this agent"** chat drawer per run.

## Consequences
- Full auditability and explainability. Storage grows with usage (retention policy comes in v1.0).
- Executors must record through the transcript port. An unrecorded LLM call is a bug.
- Secrets must never be written to transcripts. The recorder redacts known secret values.

## Alternatives considered
Storing messages inside `AgentRun.status`: documents get large and frequent rewrites conflict with optimistic concurrency.
Logging only to files or observability tools: not queryable per WorkItem, and you can't hold a conversation over them.
