# ADR-0074: Retire the legacy code workflows

- **Status:** Accepted
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Supersedes in part:** ADR-0042 §6 (keep legacy definitions loadable; explicit migration to `factory-verified`),
  ADR-0050 Rollout (`factory-planned` stays loadable for in-flight items)
- **Amends:** ADR-0003 (where the loop is defined)

## Context
Seven workflows were shipped. Four of them only existed to keep older items running while new ones replaced them:

| Workflow | Why it existed | Who used it |
|---|---|---|
| `factory-loop` + `construction-bolt` | The original loop (ADR-0003); checks advisory, verifier verdict advisory | `github-issues`, `monitoring-feedback`; many engine tests |
| `factory-planned` | Plan-first two-stage planning (ADR-0045/0046) | Nothing; superseded by `factory-plan` (ADR-0050), kept "so in-flight items keep their workflow" |
| `factory-verified` | Opt-in verified construction (ADR-0042) | Only as the target of the "Use verified workflow" migration card |

`factory-plan` already combines the one-planner run with the verification contract and is the default for manual
and `jira-main` items. The item page labelled every workflow without a `verification` policy "Legacy workflow" and
offered a migration to `factory-verified`, including on service desk items, which never build code. One click
could restart a support ticket into the code pipeline. No work item in the factory's database still uses one of
the four workflows.

## Decision
1. **Three production workflows remain:** `factory-plan` (code changes), `servicedesk` (service requests, X11/ADR-0040) and `factory-retrospective` (ADR-0041). `factory-loop`, `construction-bolt`, `factory-planned` and
   `factory-verified` are removed from `workflows/`.
2. **Sources point at `factory-plan`.** `github-issues` and `monitoring-feedback` default to `factory-plan`, like
   `manual` and `jira-main`. GitHub items therefore no longer block in triage with a clarification posted to the
   issue. The planner asks its questions in the decision sheet, as it already does for `jira-main`.
3. **No migration path to a verified workflow.** The verification migration (`VerificationActions.migrate`,
   `POST /api/workitems/{name}/verification`, the card's "Use verified workflow" button) is removed. The
   verification contract card only appears for workflows with a `verification` policy. Other workflows show no
   "Legacy workflow" badge. The `publicationDisabled` hold itself stays (retrospectives use it).
4. **Engine features stay; tests use fixtures.** Gate types (`automated`, `decision`, …), `forEach` sub-workflows,
   `humanInput` blocking and two-stage (`revisionStage`/`synthesisStage`) planning, including the planning
   migration to a one-planner workflow, remain registered capabilities. Tests exercise them through test-only
   fixture workflows (`test-loop`, `test-bolt`, `test-planned` in `web/src/core/testing/fixtures/`), loaded via an
   optional `FactoryOptions.definitionLoader` that uses the existing `DefinitionLoader` port. Production
   definitions never load the fixtures.

## Consequences
- An existing item that still references a removed workflow fails to compile and stops visibly (Q2 reconcile errors).
  It can be restarted as a new `factory-plan` item. None existed when this was decided.
- Engine tests no longer change when production workflows change. Production workflows can evolve without breaking
  unrelated tests.
- Capabilities that no production workflow uses any more (the `automated` gate's legacy check path, `forEach` with a
  sub-workflow, two-stage planning and its migration) are candidates for a later cleanup ADR. Until then they stay
  covered by the fixtures.
- AGENTS.md: new row X54 in the UX increment and the v0.3 limits note updated. Docs: README, architecture and glossary.

## Alternatives considered
- **Keep the workflows and only hide the card on `servicedesk`.** That fixes the symptom but keeps four unused
  definitions, an obsolete migration target and the "legacy" vocabulary.
- **Port every engine test to `factory-plan`.** That ties engine tests (outbox, review loop, `forEach`, gates) to
  planner output schemas and extra gates they don't test. Fixtures keep each test focused.
- **Remove the unused engine capabilities in the same change.** That is a larger refactor of the planning and
  check code with a different risk profile, so it is left for a separate ADR.
