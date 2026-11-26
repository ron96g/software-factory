# ADR-0095: Context index and on-demand artifacts

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** maintainers

## Context
Every executor (JSON LLM, tool loop, OpenCode, AgentRuntime) builds its prompt with `DefaultPromptBuilder`
(`web/src/core/agents/prompt-builder.ts`). All declared input artifacts are pasted in full with no size limit. In
`factory-plan`, `write-code` receives six artifacts, and the reviewer and verifier receive the full `source-code` diff
plus the spec and plans. Context providers add more large sections, some bounded and some not:

| Section | Limit |
|---|---|
| Unit ledger | none |
| Output JSON schemas | none |
| Ticket history | 24k chars |
| Check-failure evidence | about 36k chars |
| PR diff | 60 KB |
| Cited code | 16k chars |

Large prompts cost tokens on every model step, crowd out the task, and reduce focus. Agents already read code on demand
(`read_file`, `search_code`, `search_knowledge`, `read_check_log`). Cited code already overflows to "use read_file"
(ADR-0057). Agents have no tool to read an artifact or a context section, though. The only bounded artifact rendering
is the item digest used by the explain and chat features (`work-item-digest.ts`, ADR-0026, ADR-0037).

Making everything optional has risks:
- An agent may skip context it must use. Skipping human input would weaken rule 8.
- Each read adds a round trip, and the result stays in the history of every later step.
- Fetched content is not part of the cacheable prompt prefix.
- The one-shot JSON executor has no tools.

## Decision
1. **Two context tiers.**
   - **Inline.** The prompt always contains:
     - the work item and its description;
     - all human input: answered clarifications, gate decisions, inline feedback (ADR-0071), additional context
       (ADR-0032) and inherited evidence (ADR-0039);
     - the output and tool contracts;
     - the current Unit assignment;
     - the evidence a step exists to judge, which the step declares.

     These items are never made on-demand.
   - **Indexed.** All other inputs and large provider sections appear in a `## Available context` index. Each entry has:
     - a stable id;
     - kind (artifact or section);
     - purpose (from the `ArtifactType` or provider description);
     - producing agent and run;
     - version (`resourceVersion` or content hash);
     - size;
     - a short summary of at most about 300 chars (the artifact's own summary, else a deterministic head excerpt).
2. **Ports first (ISP).**
   - `ContextIndex` lists the entries of a built `ExecutionContext`.
   - `ContextReader` reads one entry, with an optional section heading or line/char range, bounded and truncated like
     other tool results (`agents/truncation.ts`).
   - Providers that support indexing implement an optional, separate `IndexableContextProvider` role and return an
     entry instead of a section. Providers that don't keep their inline behaviour.
3. **Run tools `list_context` and `read_context(id, section?, range?)`.**
   - Registered like the other read-only run tools.
   - Available on the tool loop, on OpenCode (as plugin tools) and on the AgentRuntime tool surface (factory-side).
   - Every call is recorded (rule 14).
   - Reads are pinned to the versions the run was built with. A replay reads the same versions.
4. **Per-step policy, default unchanged.**
   - A workflow step's input may declare `context: inline | indexed | auto`, defaulting to `inline`.
   - `auto` indexes an input above a size threshold (default 8,000 chars).
   - A step may set `contextBudget` for its total inline chars. When the budget is exceeded, `auto` inputs are indexed
     largest first.
   - Steps run by the JSON-only executor (no tools) always render inline. The workflow compiler warns when such a step
     declares `indexed`.
5. **Usage is provenance.**
   - `AgentRun.status.provenance.context` records which entries were inlined, indexed and read (id, version, ranges).
   - An input marked `required: true` that was indexed but never read before `finish` produces a Warning event. It also
     becomes gate evidence (warning level, ADR-0027). It never fails the run automatically.
6. **Measure before and after.**
   - The JSON executor records token usage like the other paths (ADR-0052).
   - The first-call prompt tokens per agent and step serve as the baseline.
   - A step is switched to `indexed` or `auto` only when the measured saving holds and its review and verification
     outcomes do not regress.

## Consequences
- Positive:
  - Smaller, more focused prompts.
  - Transcripts show which context an agent actually used.
  - Large sections become reachable without hard truncation.
  - Overflow handling is unified with cited code.
- Negative:
  - Extra round trips.
  - Agents may skip relevant context. This is mitigated by the inline floor, the `required` warning and the per-step
    opt-in.
  - Less prompt-cache reuse for indexed content.
  - One more workflow field to review.
- Follow-ups:
  - Optionally give stored artifacts summaries written by their producer.
  - Consider indexing skill bodies (skill catalog plus `read_skill`), as OpenCode already does for repository skills.
- Affected:
  - AGENTS.md §4: new item X73.
  - Ports in `web/src/core/ports/agents.ts`.
  - The prompt builder, the context factory and the run tool surface.
  - The workflow schema (`schemas/`) and `tools/validate.py`.
  - The glossary ("context index").

## Alternatives considered
- **Keep inlining, hard-truncate large artifacts.** Silently drops content and gives agents no way to recover it.
- **Everything on demand.** Human input could be skipped, which conflicts with rule 8, and one-shot agents would get
  nothing.
- **Embedding retrieval (RAG) over artifacts.** Planned only as optional work for v1.0. It is not deterministic and is
  harder to cite and replay than id- and version-pinned reads.
- **Summarize artifacts with an LLM before every run.** Adds cost and an unrecorded lossy step. Summaries may still be
  stored once as artifact metadata.
