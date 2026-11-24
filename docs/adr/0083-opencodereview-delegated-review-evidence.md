# ADR-0083: OpenCodeReview delegation mode as review-scope evidence

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** project owner
- **Builds on:** ADR-0024 (review→fix loop), ADR-0042 (check evidence), ADR-0061 (verification tiers), ADR-0067
  (self-resolving verification), ADR-0080 (agent runtime boundary), ADR-0012 (transcripts)

## Context

**The gap.** The code review is one agent run that returns free-text Markdown (`code-review-report`). Nothing records
*which files the review actually covered* or why others were skipped, so "the reviewer looked at the whole candidate"
is an unverifiable claim — and the failure modes we see in practice (an agent skips part of a large change set, cites a
line that moved, reports a finding it did not check) are exactly the ones OpenCodeReview was built to remove.

**The tool.** [alibaba/open-code-review](https://github.com/alibaba/open-code-review) (Apache-2.0) ships a Go CLI,
`ocr`, with two modes:

- **native** — `ocr review` runs its own review agent (deterministic file selection, file bundling, rule matching,
  comment positioning/reflection, post-filtering) against its **own** configured LLM provider;
- **delegation** — `ocr delegate preview|rule` performs file selection and rule resolution only. It is **LLM-free**:
  no provider, no key, no model call. The host agent then reviews the files the CLI selected, under the rules it
  resolved, and reports its own coverage.

**The constraints.** Native mode needs provider credentials inside the run and adds a second agent loop whose calls are
outside `TranscriptRecorder`; rule 16, ADR-0080 §4/§5 and ADR-0012 rule that out (a later increment may use it *only*
through the model proxy with a run- or check-scoped token). `ocr` is not in any runtime toolchain yet, and egress is
deny-by-default, so it cannot be installed during a run either.

## Decision

1. **Adopt OCR in delegation mode only.** No OCR provider configuration, no OCR model, no second agent loop; in this
   increment `ocr` never calls a model.
2. **The deterministic half becomes a check.** `Repository.spec.checks["review-scope"]` with
   `resultFormat: ocr-delegate-preview` produces the reviewable/excluded file inventory of the candidate against its
   pinned base. The format is a registered `CheckResultClassifier` (`registerCheckResultClassifiers`), so no core code
   grows a `switch (type)` (rule 4). Evidence lives in the CheckRun: logs, snapshot, tier, dedup, fences.
3. **A check command may name the candidate's pinned base** with `{{base}}`. The factory substitutes it from the
   workspace's `status.baseCommit` (validated as a 40–64 char hex commit, so it cannot carry shell syntax). A command
   that names the token is `Invalid` when the workspace has no pinned base — never guessed, never a ref name. It is
   resolved in the same place that already rewrites a scoped check's command (`resolveCheckConfig`), substituting a
   validated value instead of appending an argument, and it shares the property of `MODULES='…'` that the resolved
   command is **not** part of a check request's fingerprint: a re-pinned base (ADR-0053) produces a new attempt through
   the snapshot comparison rather than a deduplicated stale run.
4. **Outcomes are honest by construction.** Missing CLI (exit 127 / `not found`) → `Unavailable`; truncated output, an
   unrecognized `schema_version`, a non-object document, or counts that disagree with the file lists → `NotVerified`;
   a base that compared nothing, or a change set with nothing reviewable → `NotVerified`; otherwise `Passed`. Missing
   evidence is never a pass (ADR-0042), and `Passed` additionally requires that the check did not modify the candidate
   (enforced by the controller's snapshot comparison).
5. **This increment ships the seam, not the binding.** `review-scope` is deliberately not in any repository definition
   yet. A configured check changes that repository's `checkDefinitionVersion` (ADR-0064), so every in-flight item's plan
   and check evidence bound to the previous version is invalidated, and the check becomes visible to the planner
   (`verification/context.ts`) and eligible for the `verification` purpose, which has no per-check list of its own
   (`checks/origin.ts` returns *all* configured checks for such purposes). Paying that for a command that cannot yet
   succeed buys nothing. It is likewise absent from `verification.preparationChecks`: a preparation check whose command
   cannot succeed consumes its execution budget and then blocks the item with a question, which is the wrong answer to
   "the CLI is not installed in this runtime". The definition entry, the provisioning and the policy binding land
   together as X63b (Consequences a–b).
6. **OCR findings are never authoritative.** When native mode arrives, its comments enter as *claims* that the reviewer
   verifies (`reproduced` / `uncertain` / `refuted`); only reviewer-reproduced findings may block, and a human can
   still approve over advisory findings with a reason (ADR-0048). This increment adopts no OCR findings at all.
7. **Visibility and blocking are separate, and missing tooling is only visible.** A check that cannot produce evidence
   completes as `Unavailable` with `Verified=False`, a Warning event on the item, its stderr in the CheckRun log, and —
   added with this decision — a notification from the ADR-0069 catalog. Whether that also stops an item is decided by
   *binding*, not by the check: an entry in the reviewed plan's `checks[]` (or in `requiredChecks`) counts as missing
   evidence and continues only through an explicit human waiver (a check listed in `waivableChecks`) or a policy
   auto-waiver, which ADR-0067 cannot give a missing CLI; a `preparationChecks` entry retries and then blocks with a
   question. `Unavailable` is never a pass and never silently ignored.

## Consequences

**Positive.** Review coverage becomes durable, deduplicated, human-visible evidence bound to a pinned base commit; an
unconfigured or broken tool is visible (`Unavailable`/`NotVerified`) instead of silent, and now reaches a human as a
notification (ADR-0069 catalog) rather than only a timeline entry; no new agent permissions, no runtime change, no
credential, and no reviewer tool surface change; the extension point is a registry entry.

**Negative / limits.** The item's review fact is still the reviewer's prose until (c), OCR's own review quality is not
used at all, and nothing runs `review-scope` yet (decision 5). Two effects to keep in mind for (b): adding the check to
a repository definition invalidates plans and evidence bound to the previous definition version (ADR-0064) — a normal
consequence of a reviewed policy change, resolved through the ADR-0054 re-confirmation path rather than a failure — and
it makes the check eligible for the `verification` purpose for the reason in decision 5. Also, a change set with
nothing reviewable (docs-only, lockfiles) maps to `NotVerified`, so such a candidate can never show the check as green:
deliberate, and it must stay visible at the gate rather than be reclassified silently.

**Follow-ups.**

- (a) Provision a **pinned `ocr`** (version + checksum) in the runtime toolchain, recorded in provenance; absent →
  visible `Unavailable` (ADR-0029 policy still applies). Also record the P1-5 item in `docs/security.md`: rules come
  from a factory-controlled path (`--rule`), never the candidate-resident `.opencodereview/rule.json`.
- (b) Add the `review-scope` entry to `repositories/*.yaml` **and** to `verification.preparationChecks` in the same
  change, so the definition version changes once (ADR-0064) and in-flight items are re-confirmed through ADR-0054.
  Bind it as **evidence, not as a blocking requirement**: never in the plan's `checks[]` or `requiredChecks` (either
  makes "the CLI is missing" into missing gate evidence that needs a human waiver), and never in `preparationChecks`
  (retries, then a question). If gate-visible evidence is wanted later, bind it as a plan check *together with*
  `waivableChecks` so a human can continue with a reason, or introduce an explicit advisory-check role in a new ADR.
- (c) Feed the CheckRun's scope into the reviewer's context (bounded digest) and make the report **typed** —
  a `code-review-report` schema with per-finding `source` and coverage — so the gate shows what was reviewed
  (ADR-0055/0027 pattern).
- (d) Later, native mode through the model proxy only, with a check-scoped token (X60) and proxy-recorded usage.

**Kill criterion.** If, after (a)–(b), the selected file inventory plus exclusion reasons add nothing over
`git diff --name-only` and the repository's own excludes, keep the check as evidence only and do not adopt native mode.

**Affected:** AGENTS.md §4 (X63), `docs/ai-dlc-glossary.md`, `docs/security.md` (§7 P1-5),
`web/src/core/checks/{classifiers,config}.ts`; `repositories/*.yaml` at follow-up (b).

## Alternatives considered

1. **Native OCR with its own provider configuration** — rejected: a provider key inside a runtime (rule 16,
   ADR-0080 §4), and a second, unrecorded agent loop (ADR-0012, ADR-0052).
2. **OCR as a tool inside the reviewer's run** — rejected: it would grant a read-only agent process execution
   (ADR-0060 deny-by-default), and native review runs for tens of minutes with its own concurrency, fighting the step
   budget (ADR-0058); the check path provides durability, dedup, tiers, fenced leases and isolated candidate snapshots
   for free (ADR-0042, ADR-0061, ADR-0062).
3. **OCR exposed as a `ToolServer` with `spec.hostExecution: true`** — rejected: an unsandboxed vendor binary on the
   factory host (rule 18, ADR-0080 §12).
4. **Rules from `<repo>/.opencodereview/rule.json`** — rejected for now: candidate-controlled configuration must not
   weaken the candidate's own review (ADR-0080 §10). A factory-controlled, reviewed rule source passed with `--rule`
   is a follow-up, not part of this decision.
5. **A context provider that runs `ocr` before the first step** (the ADR-0057 cited-code pattern) — rejected: it would
   execute a third-party binary inside the factory process on candidate input (rule 18), instead of in a sandbox.
