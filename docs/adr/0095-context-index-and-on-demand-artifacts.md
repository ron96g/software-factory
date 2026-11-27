# ADR-0095: Context index and on-demand artifacts

- **Status:** Accepted
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

7. **Reviews: the change is a manifest artifact, every file is read and acknowledged.**

   Observed failure: a pull request with 116 files (+23,006 / −5,191) was cut off at 60 KB by
   `pullRequestContext` (`web/src/core/agents/pull-request-context.ts`), which then added the note "read the remaining
   files with read_file". The reviewer read none of them, wrote file-level findings about code it had not seen, and the
   report gave no sign of this. A prompt note does not make an agent read anything. The same risk applies to the
   `source-code` diff given to the `factory-plan` reviewer and verifier.

   - **The diff becomes an artifact, `change-manifest`.** It is produced by the factory (not an agent) from the pinned
     workspace against its base (merge-base for PRs, ADR-0094; pinned base for `factory-plan`). It lists every changed
     file with metadata only: path, previous path (renames), status (added/modified/deleted/renamed/binary), `+/-`
     lines, hunk count with each hunk's line ranges, patch size, module (ADR-0044 graph, else top-level directory), and
     review scope with its reason (ADR-0083 review-scope check, else a deterministic default rule for generated,
     vendored, lockfile and binary files). It is version-pinned to `repo@head` and `base`.
   - **Only the manifest is in the prompt.** Review steps never receive patch content inline, regardless of size. This
     replaces the patch in `pullRequestContext` and the inline `source-code` diff for review steps. There is no
     truncation, because nothing is truncated: the agent reads what it reviews.
   - **The agent reads each file's change itself.** A new read tool `read_change(path, hunk?)` returns the patch of
     one file, or one hunk of a large file, from the pinned manifest version (a separate `ChangeReader` port; the
     existing `CandidateDiffReader` stays for other callers). Surrounding code is read with the existing `read_file` /
     `search_code`. Every call is recorded (rule 14).
   - **The agent acknowledges every in-scope file.** A tool `acknowledge_change(path, outcome, note?)` with `outcome`
     `reviewed` (findings, if any, are in the report) or `skipped` with a fixed reason (`mechanical-rename`,
     `generated`, `delegated`, `budget-exhausted`). The factory accepts `reviewed` only when the run has read **all**
     hunks of that file with `read_change`; otherwise the call fails and names the unread hunks. Reading the head file
     with `read_file` does not count, because it does not show what changed. Acknowledgements are recorded and pinned
     to the manifest version.
   - **`finish` is validated against the acknowledgements (ADR-0057).** The report contract (`pr-review-report` v4,
     `code-review-report`) gets a `coverage` block that the factory fills from the acknowledgements; the agent does not
     write it. `finish` is rejected, with the list of offending files, when:
     - an in-scope file has no acknowledgement;
     - a finding names a file not acknowledged as `reviewed`;
     - the verdict is `accepted` while any in-scope file is `skipped` for `budget-exhausted`.

     The agent corrects this in the same run, like any other output error.
   - **Large changes are split by module.** When the in-scope patch size exceeds a per-step `reviewBatchBudget`, the
     step delegates module batches to runs of the same agent, each with the manifest filtered to its files (recorded
     delegation, rule 14). A batch's `reviewed` acknowledgements count for the parent, which acknowledges those files as
     `delegated` and merges the batch reports. On the graceful last step (ADR-0058) unread files must be acknowledged
     `budget-exhausted`, never dropped.
   - **Coverage is visible.** Reviewed / skipped / out-of-scope counts and the skipped files are gate evidence
     (`warning` for skipped in-scope files, else `ok`, ADR-0027), and the published PR review states the coverage, so
     the PR author sees what the factory did not review.
   - **This is the indexed tier of §1 applied to reviews, and it is not opt-in.** The diff is the evidence a review step
     judges, so its manifest is inline (§1); its content is on demand. Unlike §4, review steps switch to this directly,
     because the inline variant has been shown to lose content silently. Non-review steps keep the §4 default.

   **Implementation, stage 1 (pull request reviews).**
   - The manifest is recorded once per run as a transcript note (`meta.changeManifest`), not as an `Artifact`
     resource: it belongs to the run that was shown it, and coverage is computed against exactly that version.
   - Reads and acknowledgements are transcript notes (`meta.review`) written by the tools themselves, so the ledger is
     the same on every runtime (tool loop, OpenCode Code Mode, AgentRuntime). Coverage is derived from them on demand
     (`ReviewCoverageReader`) for `finish`, the gate and the published review; the report does not carry it.
   - The unit of reading is a *segment*: a hunk, split when it does not fit one tool result, so every segment is
     readable. `read_change(path, from?)` returns as many segments as fit and says where to continue.
   - Ports: `ChangeReviewSessions` (the `changes` tool capability) and `ReviewCoverageReader`, in
     `web/src/core/ports/change-review.ts`; the `read_change(path, hunk?)`/`ChangeReader` naming above became
     `read_change(path, from?)` on a session.
   - A skip is a claim: `accepted` is rejected while any in-scope file is skipped, except `mechanical-rename` on a file
     the manifest shows as renamed.
   - Module is the top-level directory; scope uses the default rules and generated-file detection (stage 2; ADR-0083
     classification is not wired yet).
   - Runs on a pull request item without a review report (research, explanation) get the manifest and `read_change`
     but are not asked to acknowledge.
   **Stage 2 (benchmark: controlplane PR #665, 116 files, +23,006 / −5,191).** 59 of its files carry Go's
   `Code generated … DO NOT EDIT` header and hold 24,587 of the changed lines; the hand-written part is 57 files and
   3,610 lines. With only the default rules, the reviewer would have had to acknowledge about 100 files in 30 steps.
   - **Generated files are recognised.** A file whose head version has the header in its first 40 lines (`//`, `#`,
     `--` or `/*` comment, or `@generated`) is out of scope as `generated (header)`; a deleted file is judged by its
     removed lines. `Repository.spec.review.generatedPaths` (globs, reviewed definitions) covers generated files
     without a header, e.g. `controlplane-api/ent.graphql`, as `generated (repository)`.
   - **A header is the author's claim.** A modified file whose header is added by this change stays in scope, with a
     note. A new file with a header is trusted; the out-of-scope count per reason is part of the coverage line at the
     gate and in the published review, so a human sees what was excluded and why. Whether generated code matches its
     source is a check (candidate preparation, ADR-0043), not a review question.
   - **Several files per call.** `read_change({ paths, from? })` returns files in order, as many segments as fit,
     and names where to continue; `acknowledge_change({ files: [...] })` applies or refuses each file on its own. The
     manifest is grouped by module, so a reviewer works module by module.
   - The manifest version includes the scope, so a changed `generatedPaths` is a new manifest; it is recorded once
     per run. The ledger is read incrementally (transcripts are append-only) and cached per transcript.
   - **A read counts once its result reached the model.** The first benchmark run (controlplane#665) showed 55/55
     files "reviewed" in five model steps: Code Mode programs (`execute`, ADR-0078) called `read_change` in loops,
     filtered the diffs (only `+`/`-` lines, only test titles, `slice(0, 45000)`) and called `acknowledge_change` for
     all files in the same program. The tool ran, so the ledger counted it. Now `read_change` and
     `acknowledge_change` are direct tools (`codemode: false`, like `finish`), and each read records the latest model
     step; it counts only once a later model step exists (tool loop: `meta.step` on calls; OpenCode: step-ended
     notes). A read and an acknowledgement in the same batch therefore cannot cover a file. A runtime that records no
     step markers falls back to counting every read (AgentRuntime, until it records steps).
   - **A budget skip is checked against the budget.** The second benchmark run covered 41 of 55 files honestly but
     skipped 14 test files as `budget-exhausted` with 10 of 30 steps left. Now every `read_change` /
     `acknowledge_change` result states the model steps left, and `budget-exhausted` is refused until the wrap-up
     window (the last 3 steps, ADR-0058). Other skip reasons are not budget-bound; `accepted` with any skip is still
     rejected at `finish`.
   - Review report types are registered in the composition root (`reports`), and `ReviewCoverage.summary` carries
     the coverage line, so the app reads coverage only through `ReviewCoverageReader`.
   - Pending: `factory-plan` code-review and verify (they need the typed `code-review-report` of X63c to apply the
     finding rule), module fan-out for very large changes, and the ADR-0083 scope reasons.

## Consequences
- Positive:
  - Smaller, more focused prompts.
  - Transcripts show which context an agent actually used.
  - Large sections become reachable without hard truncation.
  - Overflow handling is unified with cited code.
  - A review can no longer claim to cover code it never read; partial coverage is visible at the gate and on the PR.
  - Large pull requests are reviewed in full, in batches, instead of by their first 60 KB.
  - Review prompts no longer grow with the size of the change; only the manifest does.
- Negative:
  - Extra round trips.
  - Agents may skip relevant context. This is mitigated by the inline floor, the `required` warning and the per-step
    opt-in.
  - Less prompt-cache reuse for indexed content.
  - One more workflow field to review.
  - Large reviews cost more (fan-out runs plus a merge step); this is the price of actually reading the change.
  - Small changes now need a `read_change` round trip per file that used to be inline.
  - `pr-review-report` v4 and the `code-review-report` coverage field are contract changes (ADR-0055); older reports
    stay readable but carry no coverage.
- Follow-ups:
  - Optionally give stored artifacts summaries written by their producer.
  - Consider indexing skill bodies (skill catalog plus `read_skill`), as OpenCode already does for repository skills.
- Affected:
  - AGENTS.md §4: new item X73.
  - Ports in `web/src/core/ports/agents.ts`.
  - The prompt builder, the context factory and the run tool surface.
  - The workflow schema (`schemas/`) and `tools/validate.py`.
  - The glossary ("context index", "change manifest", "review coverage").
  - `pullRequestContext`, new `change-manifest` ArtifactType, `ChangeReader` port, `read_change` / `acknowledge_change` tools, `pr-review-report`,
    `code-review-report`, the `pull-request-review` and `code-review` skills, and the PR review publisher (coverage line).
  - Builds on ADR-0083 (review scope) and ADR-0094 (PR review).

## Alternatives considered
- **Keep inlining, hard-truncate large artifacts.** Silently drops content and gives agents no way to recover it.
- **Everything on demand.** Human input could be skipped, which conflicts with rule 8, and one-shot agents would get
  nothing.
- **Embedding retrieval (RAG) over artifacts.** Planned only as optional work for v1.0. It is not deterministic and is
  harder to cite and replay than id- and version-pinned reads.
- **Raise the PR diff limit.** Moves the cliff; a 23k-line change still does not fit, and nothing proves it was read.
- **Let the agent self-report coverage.** The observed reviewer would have reported what it believed; an
  acknowledgement only counts when it is backed by recorded reads.
- **Inline small diffs, index only large ones.** Keeps two review modes and the size cliff; one mode where the agent
  always reads and acknowledges is simpler to enforce and to explain.
- **Reject oversized PRs outright.** A reviewer may still recommend splitting a PR, but refusing to review it leaves
  the human with nothing; batching gives a complete review and the recommendation.
- **Summarize artifacts with an LLM before every run.** Adds cost and an unrecorded lossy step. Summaries may still be
  stored once as artifact metadata.
