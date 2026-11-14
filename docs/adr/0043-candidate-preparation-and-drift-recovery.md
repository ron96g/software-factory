# ADR-0043: Prepare candidates before review and recover from candidate drift

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Maintainers

## Context
ADR-0042 correctly invalidates verification when a command changes the reviewed tree. A real build regenerated
code that the reviewer had requested reverting. Candidate checks then raised a clarification while the build
was still running. Answering it reran verification, not code-review, so no fresh approval could be obtained.
The verifier also guessed repository aliases that the named-check tool rejected.

## Decision
- Observe owned active CheckRuns before fingerprinting, starting another agent or advancing an answered
  clarification. Pending/running checks yield a durable wait, not candidate-drift attention.
- `Workflow.spec.verification.preparationStage` names the existing candidate-review stage. Repository policy
  declares `preparationChecks`, a subset of configured checks in the approved plan. These run through the
  existing CheckRun scheduler before that stage's AI review and human approval.
- A `preparation` job may generate/format source. Persist its command `executionOutcome` separately from
  authoritative `outcome`: a successful command that changes the tree remains NotVerified. Preparation may
  proceed only from complete successful execution with a final snapshot matching the current candidate.
  Preparation is never substituted for final verification evidence. Final checks still require an unchanged tree.
- Give reviewers preparation provenance and instructions to inspect current workspace code, including generated
  changes, rather than blindly reverting a reproducible build output. Generated code remains fingerprinted.
- A missing/stale candidate approval returns to the workflow's candidate-review stage. Persist a separate
  `candidate-drift` retry counter, bounded by the approved execution retry budget. Exhaustion requests durable
  attention with an actionable diagnostic; it never grants approval or loops indefinitely.
- `run_check` accepts an owned workspace name or unique repository alias and a bare or matching canonical
  check identity. Publish valid identifiers in context and errors. Normalize before deduplication and enforce
  the approved plan, command configuration, ownership and execution budget.
- Existing items do not automatically migrate or resume. An explicit restart after policy changes requires
  a new plan review. Keep workspace/history and publication holds intact; no approvals or pushes are implied.

## Consequences
- Extends ADR-0042 without weakening its freshness, required-evidence or human-approval rules.
- AGENTS.md X24 records this repair. CheckRun, Workflow and Repository gain additive fields; no new kind,
  adapter, external infrastructure or arbitrary command endpoint is introduced.
- Preparation adds build cost before review. Subsequent attempts can reuse preparation only for the exact
  plan, repository, environment and resulting candidate. Repeated drift requires human investigation.
- Regression tests cover active-check waits, real controller transitions, bounded drift, preparation freshness,
  changed-tree NotVerified results, alias normalization and preserved required-evidence enforcement.

## Alternatives considered
- Ignore generated files in fingerprints: could publish unreviewed code.
- Reuse old approval or interpret a clarification answer as approval: bypasses the bound human gate.
- Only tell the human to restart code-review: retains the revert/regenerate cycle and the active-check race.
- Move checks onto isolated candidate copies: useful later, but does not by itself solve generated-code review
  or incorrect recovery, and requires a separate workspace/execution design.
