# ADR-0030: Knowledge base (approved agent knowledge + external docs)

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** project owner
- **Extends:** ADR-0002, ADR-0006, ADR-0008, ADR-0012, ADR-0026

## Context
Every work item starts from zero. Agents rediscover the same facts (where a behaviour lives in the code, how a recurring
service desk request is resolved), and useful external documentation (product docs, runbooks) is not available to them
beyond a repository's README/AGENTS.md. We want both:
1. **External docs** that humans maintain, searchable by agents. Kept simple now; vector search later.
2. **Agent-managed knowledge**: agents write down what is useful for others or for future work.

Agent-written knowledge is risky: a wrong conclusion that is stored gets cited as fact by later agents, and inputs such
as service desk tickets are written by outsiders (prompt injection). Rule 8 (AI proposes, humans approve) applies.

## Decision
1. **`KnowledgeEntry` (runtime kind, plural `knowledgeentries`).** `spec`: `title`, `content` (Markdown), `tags`,
   `scope` (`repositories`, `workflows`; every non-empty dimension must match, empty = global), `provenance` (agent,
   run, work item, time), the human `review` (`approve | reject`, by, at, comment) and `retired`. Scope and provenance
   are plain names, not refs: entries outlive the items and definitions they came from and have **no owner**
   (deleting an item never deletes knowledge; a renamed definition never makes an entry uneditable).
   The knowledge controller owns `status` and derives the phase:

   ```mermaid
   stateDiagram-v2
     [*] --> Proposed: agent proposes (run result)
     Proposed --> Approved: human approves
     Proposed --> Rejected: human rejects
     Approved --> Retired: human retires
     Rejected --> Proposed: human edits (or applies a draft)
     Approved --> Proposed: human edits (or applies a draft)
   ```
2. **Capture.** Agents with the `knowledge-base` skill may return `knowledge: [{ title, content, tags }]` in their
   result (JSON mode and the tool loop's `finish`). The AgentRun controller creates `Proposed` entries with deterministic
   names (`<run>-k<i>`, idempotent: an existing entry is never overwritten), redacted content (ADR-0015), provenance,
   and the work item's repositories and workflow as scope. Runs without the skill never propose. Replays (ADR-0012) and superseded runs (ADR-0029) never propose knowledge.
3. **Approval always first.** Only `Approved` entries are ever shown to agents. A human edits title, content, tags and
   scope directly, or **together with the proposing agent**: a `Conversation` with purpose `refine-knowledge`, owned by
   the entry, where the agent (its definition as persona) suggests a revised draft. The responder is side-effect free;
   the human applies a draft with one click (a normal spec edit). **Every** edit puts the entry back to `Proposed`, so
   nothing reaches agents without an approval of its current text.
4. **`KnowledgeSource` (definition kind, folder `knowledge-sources/`).** External docs: `type` (`files` now),
   `local.path`, `include`/`exclude` globs, `scope`. Search implementations are registered per `type` (rule 4), so a
   vector store is a new type later, not a change to the core. `files` uses ripgrep (like ADR-0008).
5. **Retrieval.** A `KnowledgeSearcher` port searches approved entries (keyword scoring) and the knowledge sources in
   the run's scope, re-checks approval against the current spec, and redacts hits. It feeds a context provider (for agents with the `knowledge-base` skill; sections are marked as
   reference material with their provenance, never as instructions) and a read-only `search_knowledge` tool.

## Consequences
- Knowledge accumulates across items and workflows, with a human checkpoint and full provenance.
- No new controller waits on humans; review is a spec edit like approvals.
- Known limits: keyword search only; entries are not yet re-validated when the cited code changes (seam: provenance
  keeps the run, whose provenance pins `repo@commit`); one runtime namespace (per-squad knowledge comes with v0.4).

## Alternatives considered
- Agents write approved knowledge directly: fastest, but self-poisoning and prompt injection (rejected, rule 8).
- Storing knowledge as files in Git: reviewable via PRs, but agents would need write access to the factory repo and the
  UI loses the propose/approve flow.
- A vector database now: better recall, but a new dependency before we know the volume (deferred to a new
  `KnowledgeSource.type`).
