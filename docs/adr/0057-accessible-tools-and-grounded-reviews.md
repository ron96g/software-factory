# ADR-0057: Accessible agent tools and grounded reviews

- **Status:** Accepted
- **Amended by:** ADR-0058 (runs out of budget end with a finish-only wrap-up step)
- **Date:** 2026-11-15
- **Deciders:** project owner
- **Amends:** ADR-0022 (how read tools are offered), ADR-0049 and ADR-0055 (where output is validated),
  ADR-0055 (planning-review evidence)

## Context
Agents with read-only workspace tools rarely use them. Tool-loop provenance across the local factory shows the
plan reviewer calling `finish` on its first model step in 34 of 43 runs, the architect in 14 of 16 spec runs and
15 of 15 validation-plan runs, and the triager in all 7 runs. Agents that cannot produce anything without tools
(developer, verifier, code-researcher) always use them. The difference is not the model or the tool permissions,
but how the harness presents the work:

- Tools are offered only as bare function schemas. The prompt mentions "the tools listed to you" but never lists
  them, says what they are good for in this run, or how to use them together.
- All input artifacts are inlined (about 26 KB for a plan review), but the code they cite is not. A document
  consistency check therefore looks complete without opening any file.
- `read_file` returns a whole (clipped) file without line numbers or ranges. Checking a citation such as
  `web/src/core/planning/evidence.ts:12-19` is clumsy, and quoting exact lines back is error-prone.
- `finish` is always the cheapest action, and output contracts are checked only after the run has ended. Any
  mistake costs a complete new AgentRun that has lost the previous conversation (ADR-0049, ADR-0055).
- The ADR-0055 `planning-review` schema accepts only input artifacts as finding evidence. Code the reviewer reads
  has no place in the result, so reading it has no visible effect. One review flagged a "research gap" for a claim
  whose cited code proves it, and stated it had not read the code.

The owner's constraints: improve tool use through the harness rather than per-agent instructions in agent
definitions, and keep rejection and retry as the exception for genuinely wrong output, not the normal path.

## Decision
### 1. Cited code is resolved before the first model step
- A registered `cited-code` ContextProvider applies to every run whose context has pinned workspaces
  (`ctx.workspaces`), in tool-loop and JSON mode alike; it does not need a sandbox. It extracts `repo:path:line` and
  `repo:path:start-end` citations from input artifacts, WorkItem context and recorded answers, and resolves them
  against the run's pinned workspace commit.
- It reads only through the existing read-only workspace reader port over the run's own workspaces (the reader the
  tool loop already uses), so ADR-0022 read narrowing applies unchanged. Citations are untrusted text: paths must be
  relative and stay inside the workspace (no absolute paths, `..` or symlink escape, as the reader enforces today).
  A citation naming a repository outside the run's workspaces is reported as `not-readable` without being probed,
  so statuses never reveal what exists beyond the run's grants.
- Each readable citation gets a status (`resolved`, `missing-file`, `out-of-range`) and resolved ones get a
  line-numbered excerpt with a small surrounding window. Budgets bound the number of citations, lines per excerpt
  and total size; overflow is listed by reference so the agent can read it with tools.
- Excerpts are workspace file content and are treated exactly like `read_file` results: they reach the model
  unredacted, which ADR-0019 §7 and ADR-0022 accept because workspaces hold no factory secrets. Like all context,
  the section is recorded through the TranscriptRecorder, whose ADR-0012 redaction applies to the transcript copy.
- The section is recorded with a digest over the commit and the resolved references, like other context. It states
  that code at the pinned commit takes precedence over prose in earlier artifacts (for example stale research
  notes). Unresolved citations are reported as facts for the agent; the harness never turns them into findings and
  never judges whether a claim is true.

### 2. The harness explains the tools it binds
- Built-in tool registry entries gain optional guidance: when the tool helps, and one example call. It is static,
  trusted harness text kept on the registry entry, not added to the bound tool port every implementation provides.
  Agent definitions keep declaring only tool names; ADR-0016/0022 narrowing is unchanged.
- The tool loop renders a "Tools for this run" section from the tools actually bound for this run, including the
  workspaces and pinned commits they read. It replaces the vague "tools listed to you". MCP tools (ADR-0034) are
  listed by name and server only; their untrusted descriptions stay in the tool schema and are never rendered as
  harness guidance.
- Read-capable runs get one generic protocol: check the claims you rely on against the pre-resolved excerpts first,
  then with the tools, then judge; cite what you checked as `repo:path:line`.

### 3. Read tools return citable results
- `read_file` accepts an optional `startLine`/`endLine` or a citation string `ref`, and returns line-numbered
  output. When clipped, it reports the returned range and how to continue.
- `search_code` accepts optional context lines. Results stay `repo:path:line`, copyable as citations.
- Capabilities, read-only status and permissions are unchanged.

### 4. Output is checked when the agent calls `finish`
- The tool loop depends on a narrow, side-effect free `FinishValidator` port. Its input is the run's execution
  context (AgentRun, WorkItem, pinned workspaces and their read-only reader) plus the proposed result: the final
  assembled artifacts (including the sandbox diff appended to `source-code`), outcome and questions. It returns
  actionable errors or none. The composition root adapts the ArtifactCheck registry (schema checks, domain checks
  and outcome agreement) to it, checking unsaved proposed artifacts rather than persisted Artifacts.
- Checks that need the workspace (§5) use a separate, narrow workspace-aware check port, so the existing
  `ArtifactCheck(item, artifact)` contract is not widened. After the run, the controller re-runs it against the
  workspace commit recorded in the run's provenance. If that workspace is no longer readable, the check fails visibly;
  it never passes by default.
- On `finish`, the loop validates before ending. A rejected `finish` is not terminal: the loop records the `finish`
  tool call and a tool result containing the errors (ADR-0012), returns the errors in the same actionable format
  as today (JSON path, keyword, parameters), and continues. The agent corrects in the same conversation, keeping
  its context and gathered evidence.
- In-loop corrections are bounded (two by default) and count toward the step budget. When the budget is exhausted,
  the loop returns the last result instead of throwing. The post-run output checks then reject it and the existing
  producer-only rerun (ADR-0049, ADR-0055) remains the backstop. Post-run checks always run, so in-loop validation
  is never the only guard. A run that never calls `finish` within its step budget still fails as today.

### 5. Planning reviews may cite code (`planning-review` schema version 2)
- Finding evidence is either `{ artifact: { name, resourceVersion } }` or
  `{ code: { repository, path, startLine, endLine } }`. Code evidence is checked through the workspace-aware check
  (§4) against the run's pinned workspace commit: the repository is one of the run's workspaces, the file exists
  and the lines are in range. This proves the location, not the claim.
- A `research-gap` finding must list what was investigated (code evidence and/or search queries) and why it did not
  settle the claim. One without any investigation is rejected through §4.
- An optional `verified` list records claims the reviewer confirmed with code evidence. They are shown as checked
  claims, not findings, and never block.
- The `planning-review` skill is reordered: investigate cited and assumed facts first, then review the documents.
- Version 1 reviews stay readable. As in ADR-0055, plan approval binds the review schema digest, so open proposals
  need a fresh review after this change. The planning workspace shows them as "needs agent repair" and offers a new
  revision; live items are not restarted, answered or approved automatically.

### 6. Tool use is observable, not forced
- AgentRun provenance records steps, tool calls by name, cited-code resolved/unresolved counts and in-loop
  `finish` corrections. These measure the effect of this ADR and are never gate criteria.
- The harness does not require a minimum number of tool calls and does not withhold `finish`.

## Consequences
- AGENTS.md adds X37. No new resource kind or database migration. New pieces: tool guidance metadata in the tool
  registry, a `cited-code` ContextProvider, the `FinishValidator` port and adapter, a workspace-aware artifact check
  port, read-tool parameters, and `planning-review` schema version 2 with its domain checks.
- Required tests for the implementation: citation parsing, confinement and `not-readable` handling; excerpt budgets
  and overflow; tool section lists only bound tools and never renders MCP descriptions as guidance; ranged
  `read_file`; a rejected `finish` keeps the conversation, records call and result, and stops after the correction
  cap with post-run checks still applied; code evidence validated in-loop and post-run against the recorded commit;
  research gaps without investigation rejected; version 1 reviews still render.
- Evidence requirements prove where a reviewer looked, not that it looked carefully: an investigation entry could
  name a search that settles nothing. Humans still judge the findings (ADR-0048).
- All tool-loop agents get the new tool section, so prompt hashes change. Replays use recorded prompts, so
  historical transcripts keep their meaning.
- Prompts grow by the bounded cited-code section. Reviews and plans should need fewer full reruns and produce fewer
  false research gaps.
- Excerpts come from the same pinned read-only workspace the run can already read; no new access is granted.
- JSON-mode executors benefit from §1 immediately (context provider). Applying §4 to them is a follow-up.
- Follow-ups from ADR-0055 remain open: cross-revision finding resolution and broader decision lineage.

## Alternatives considered
- **Tool instructions in each agent definition:** rejected by the owner. It does not scale, drifts per agent and
  leaves the harness unchanged.
- **Forcing tool use** (minimum steps, hiding `finish`, mandatory tool choice): produces token-burning calls rather
  than evidence, and penalizes runs that genuinely need none.
- **Stop inlining input artifacts:** makes every run slower and costlier without telling the agent what to check.
- **Harness judges whether claims are true:** not deterministically possible. The harness resolves locations; agents
  and humans judge meaning.
- **Rely on post-run rejection and rerun:** the status quo. It loses the conversation and makes retries the normal path.
