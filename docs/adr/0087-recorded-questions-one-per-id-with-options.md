# ADR-0087: A recorded question is one decision, with the options it offered

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** project owner
- **Builds on:** ADR-0072 (the plan gate waits for answers; an answer binds to the same question), ADR-0050 (one planner
  run, revocable answers), ADR-0055 (typed planning reviews)
- **Amends:** ADR-0072 §"An answer binds to the same question" — a recorded question binds by its text even when it
  offers options

## Context
The `factory-plan` item `file-download-proxy-in-controlplane-api-for-files-stored-in` showed the same open question
twice on its plan-review sheet, both without answer options:

- `question-20bc0c6c91cb0db9993c` — the **code-researcher's** `Q1` (triage step 0)
- `question-667f495f7dae930a8a97` — the **triager's** `Q1` (triage step 1)

Both were the same question ("Should the public download proxy serve any file-manager ID…"), recorded under the same
id `Q1` with slightly different wording. Three separate rules produced the symptom:

1. `PlanningService.decisions()` folds a run's recorded questions into the sheet, but only skips one when a plan/review
   decision cites its id in `answersQuestionIds`, or when its **exact normalized text** equals an existing decision's
   question. It never deduplicates by the question's own stable id. Two agents re-recording `Q1` with different wording
   therefore became two decisions.
2. The latest plan had **dropped `Q1`** (the human's revision feedback settled it as "Any file ID"), so no decision
   referenced id `Q1` and the wording did not match — both recordings resurfaced as required questions.
3. Every recorded question was projected as `options: []`, discarding the options the agent supplied (and the default
   blocker options from `normalizeQuestions`). So even a question the agents had made answerable showed no choices.

The item was already answered in substance; the sheet still asked the human to answer two option-less copies of it.

## Decision

### 1. A recorded question is deduplicated by its stable id
`decisions()` keeps the **first** recording per `normalizeQuestions` id (runs are listed in creation order, so the
earliest agent wins). A later agent that re-records the same id with different wording no longer adds a second
decision. Distinct ids (including the hash of the text when an agent supplies none) stay separate questions.

### 2. A recorded question keeps the options it offered
The `question-…` decision carries the options the question recorded (`options` from `normalizeQuestions`), including
the default blocker options for a blocker that supplied none. The human answers one question with the choices the
agent proposed, exactly as a `Clarification` already does.

### 3. A recorded question binds by its text even with options
`binds` gains one clause: a decision whose id starts with `question-` binds to an answer whose question text matches
(case and whitespace ignored), whether or not it has options. A recorded question is identified by its text; its
options are the agent's suggestions, not a new identity. Plan decisions are unchanged: a matching signature is still
required, and changed options or wording still need a fresh answer (ADR-0072).

## Consequences
- The observed item shows one `Q1` with its two options instead of two option-less copies.
- ADR-0072's guarantee holds for recorded questions with options: an answer already given to the same question text is
  not asked again.
- Recorded questions are now answerable by option, consistent with `Clarification` (ADR-0007/ADR-0029).
- A recorded question that offers options now contributes its options to the plan fingerprint, so an in-flight plan
  approval whose evidence was bound before this change may be re-confirmed in place (ADR-0054). This is a code change,
  not a definition change; no migration is needed for stored resources.
- Not addressed here: a question the plan *settled and dropped* through revision feedback (no recorded answer) still
  resurfaces once, because nothing records that it was settled. It now resurfaces as one answerable question. Closing
  that gap needs the planner to keep the id with its answer, or a "settled" marker on the decision.
- A same-id collision is possible: two agents that independently use the same id (e.g. `Q1`) for genuinely different
  questions are merged, first recording wins. Agent definitions already ask for stable ids, and the surviving question
  is still shown and answerable; a reused id for a different question is an agent error.
- Code: `PlanningService.decisions()` and `binds` in `web/src/core/planning/service.ts`. No new port, kind or
  controller.
- AGENTS.md: item **X67**. No glossary term.

## Alternatives considered
- **Deduplicate by normalized text only.** Already the behaviour; it misses reworded copies of the same id, which is
  the observed case.
- **Keep recorded questions option-less** (ADR-0072 as-is) and only deduplicate by id. Fixes the duplicate but leaves
  the question unanswerable by choice, which is the second half of the report.
- **Fuzzy-match question text across ids.** Could merge genuinely different questions; the stable id is the explicit,
  agent-declared identity and is the safer key.
- **Suppress a question the plan settled and dropped.** The plan carries no record that a dropped decision was settled
  by feedback, so this needs a model change; deferred (see Consequences).
