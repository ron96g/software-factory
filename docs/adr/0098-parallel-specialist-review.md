# ADR-0098: Parallel specialist review

- **Status:** Proposed
- **Date:** 2026-11-27
- **Deciders:** maintainers

## Context
The `pr-review` workflow (ADR-0094) has one `reviewer` run judge the whole change. ADR-0095 §7 made that review honest:
- every in-scope file of the change manifest must be read with `read_change` and acknowledged;
- `finish` rejects findings on files the run did not read;
- coverage is derived from the run's recorded reads.

Two limits remain:
- **One generalist misses specialist issues.** The same reviewer looks for security, correctness, architecture and API
  breakage at once, with one skill set and one model.
- **Large changes need splitting.** ADR-0095 §7 plans "module batches delegated to runs of the same agent", merged by
  the parent, but that is not built yet.

Running specialists as parallel workflow steps does not fit the current engine:
- Steps in a stage run one at a time (`runtime/controllers/workitem.ts`).
- Inputs and the publisher take only the newest artifact of a type.
- ADR-0095's coverage is per run, so a merging step would cite files it never read and `finish` would reject it.

Requiring every specialist to read every file would multiply the cost of a large change by the number of specialists.

## Decision
1. **One review fan-out, two splits, two phases driven by the controller.**
   - **Planning and creating are separate ports (ISP).**
     - `ReviewSlicePlanner` turns the pinned change manifest, the step's specialties and the module batch budget into
       slices. It is pure and deterministic.
     - `ChildRunLauncher` creates one child AgentRun per slice.
   - **No LLM session is suspended. A fan-out step runs in two phases, both reconciled by the WorkItem controller
     (rule 6):**

     ```mermaid
     sequenceDiagram
       participant C as WorkItem controller
       participant S as Specialist children
       participant R as reviewer (merge run)
       C->>C: build manifest, plan slices
       C->>S: create one AgentRun per slice (parallel)
       S-->>C: terminal (Succeeded / Failed)
       C->>R: create merge run with children's findings + union coverage
       R-->>C: pr-review-report
     ```

     1. **Fan-out.** The controller builds the manifest, plans slices and creates the children. The step's status
        records the phase (`fanOut`) and the child run refs. The step waits, like any step waits on its run, until
        every child is terminal.
     2. **Merge.** The controller creates the `reviewer` run of the step. Its inputs are the children's findings and
        the union coverage. Its output is the step's output.
   - **Children are delegations (rule 14).**
     - Each child carries `spec.parentRunRef` (the step's merge run name, reserved up front), its own transcript and
       its own review ledger.
     - Each child is nested under the reviewer in the run view.
     - Children use only read-only tools, so they take no workspace lock and run concurrently.
   - **Names are deterministic:** step, round, specialty, module batch. After a restart only missing children are
     created.
   - This mechanism also implements ADR-0095 §7's module batches. There is no second fan-out.
   - **A replay (W5) never fans out.** It re-runs the merge from the recorded child artifacts.
2. **Specialties are step configuration with checked refs (rule 4).**
   - A step lists its specialties under `review.fanOut.specialties[]`. This is not a new kind. Each entry names:
     - `agentRef` and `skillRefs`, checked by `tools/validate.py` and admission like any step ref;
     - `relevance`: a list of typed rules;
     - `required` (default `false`).
   - **Relevance rule types are registered `RelevanceRule` evaluators, not a switch:**
     - `paths` (globs);
     - `modules` (ADR-0044 graph);
     - `scope` (review-scope classes).

     A file is relevant to a specialty when any of its rules matches.
   - The first specialists:

     | Agent | Focus |
     |---|---|
     | `security-reviewer` | `docs/security.md`, trust boundaries, secrets |
     | `correctness-reviewer` | logic, edge cases, whether tests cover the change |
     | `design-reviewer` | AGENTS.md rules, ADRs, ports & adapters (named to avoid the harness sub-agent `architecture-reviewer`) |
     | `api-compat-reviewer` | breaking changes in APIs, schemas, contracts |

   - Each agent declares only `model.tier` (ADR-0014, ADR-0028).
   - A step enables fan-out with `review.fanOut: { specialties: [...], moduleBatchBudget? }`.
3. **Specialists read what is relevant; coverage is the union.**
   - Every specialist gets the full manifest with its relevant files marked.
   - It must read and acknowledge its relevant files under the ADR-0095 rules.
   - It may acknowledge any other file as `not-in-specialty`, a new skip reason. That skip does not block `accepted` on
     its own.
   - In-scope files that no specialty claims go to a general child (`reviewer` with `code-review`), so every in-scope
     file has a reader.
   - `ReviewCoverageReader` combines the parent's ledger with its children's:
     - a file is `reviewed` when the parent or any child read all of its segments;
     - the parent sees such a file as `delegated`, with the reviewers that read it.
4. **The reviewer merges and decides the verdict.**
   - **Children write `specialist-findings` v1.** This is a schema-backed ArtifactType (ADR-0055): findings anchored to
     file and line, tagged with the specialty, with severity and no verdict.
     - The child's `finish` validates it against the child's own ledger, under the ADR-0095 rules.
     - Findings are agent output derived from untrusted pull request content. They are redacted and treated as data,
       never as instructions (ADR-0080).
   - **The merge run receives its children's findings through a `fan-out-findings` context provider.**
     - The provider selects artifacts by the child run refs recorded on the step, not by "newest of a type". It
       renders them inline, because they are the evidence the step judges (ADR-0095 §1).
     - It records the artifact versions in provenance, so a replay reads the same findings.
   - **ADR-0097 review discussion goes to the merge run only.** It concerns the verdict, not one specialty.
   - The `reviewer` removes duplicates, settles conflicts and writes the single `pr-review-report` with the verdict.
   - ADR-0095's `finish` rules apply to the merged coverage:
     - a finding may only name a file that a child (or the merge run itself) marked `reviewed`;
     - `accepted` is refused while any in-scope file has no reader.
   - **`pr-review-report` gains an optional `coverage.bySpecialty` (v5).**
     - It is filled by the factory, like the rest of coverage.
     - v4 reports stay readable without it.
   - The publisher (ADR-0094) and the gate stay otherwise unchanged.
5. **A failed child is a visible gap, not a silent one.**
   - Quota waits (ADR-0031) still apply.
   - A child that fails terminally or exhausts its budget does not stop the merge. The merge proceeds with what exists.
   - Every failed child is warning-level gate evidence (ADR-0027) and is named in the published review:
     - a failed specialty is named by its specialty;
     - a failed general fallback child or module batch is named by its slice and its files.
   - A specialty with `required: true` makes this evidence blocking. ADR-0027's override with a reason still applies.
   - Files that only the failed child covered stay unread. They therefore block `accepted`, as before.
6. **Scope.**
   - The `pr-review` workflow's `review-change` step only.
   - `factory-plan` code review and verify follow once the typed `code-review-report` (X63c) exists.
   - Parallel step groups in workflows are not introduced.

## Consequences
- Positive:
  - Specialist skills and models per concern, visible per specialty in transcripts, metrics (ADR-0082) and
    retrospectives (ADR-0041).
  - Wall time of large reviews drops: children run concurrently.
  - ADR-0095's pending module fan-out is built once, for both uses.
  - Coverage stays backed by recorded reads; nothing is claimed without a reader.
- Negative:
  - More runs and tokens per review. Relevance rules and module batches bound this, but overlapping specialties still
    read some files twice.
  - Relevance rules can be wrong. The fallback general child limits the damage to depth, not coverage.
  - Parent/child bookkeeping on the step (fan-out phase, child refs) adds controller logic.
- Open:
  - Each child has its own run-scoped token (X60, one per AgentRun). Open: an aggregate step and token cap per fan-out.
- Affected:
  - AGENTS.md §4: new item X76.
  - Glossary: *specialist reviewer*, *specialty*, *review fan-out*.
  - Ports:
    - `ReviewSlicePlanner`
    - `ChildRunLauncher`
    - `RelevanceRule` registry
    - `ReviewCoverageReader`: a new union read method; existing per-run reads are unchanged.
  - The `fan-out-findings` context provider.
  - The WorkItem controller (fan-out/merge phases) and `AgentRun.spec.parentRunRef`.
  - The `specialist-findings` v1 ArtifactType and `pr-review-report` v5 (`coverage.bySpecialty`).
  - Four agents and their skills.
  - `pr-review.yaml`.
  - The workflow schema and `tools/validate.py`.
  - Gate evidence, the published coverage line, and the run view (children nested under the reviewer).
  - Amends ADR-0095 §7 (adds the `not-in-specialty` skip, union coverage, and the fan-out mechanism). Builds on
    ADR-0094.

## Alternatives considered
- **Parallel step group in the workflow plus an aggregator step.**
  - Visible in the workflow, but it needs grouped scheduling, list inputs and a coverage merge across sibling steps.
  - It duplicates the fan-out ADR-0095 already needs for module batches.
- **Every specialist reads every file.** Strongest coverage, but N× cost on exactly the large changes that already
  exhaust budgets.
- **The factory assigns files, specialists don't skip.** Deterministic, but a specialist then cannot follow a
  relevant change into a file the rule missed.
- **Merge findings in code, no lead reviewer.** Cheaper, but there is no deduplication or conflict judgement, and the
  verdict becomes a mechanical severity maximum.
- **Block when any specialist fails.** One quota or budget failure would withhold the whole review. A visible gap with
  opt-in `required` keeps the human informed without stalling.
