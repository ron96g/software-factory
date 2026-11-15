---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: planning-review
spec:
  description: Independently challenge a complete planning bundle before its exact-revision human review.
---

# Planning review

First check the facts the plan relies on. Use the "Cited code" excerpts in your input, then the read tools for
claims they don't settle. A fact checked in code at the pinned commit overrides older research notes.
Then read the current specification, Units, implementation plan, research and validation plan together.

- Is the outcome understandable without reading transcripts?
- If the plan is a decision sheet (only `risks` and `decisions`), does it avoid restating the other artifacts or
  pre-empting the later design, and are its risks written in plain language?
- Do scope, dependencies and testable delivery results agree across documents?
- Does every acceptance criterion map to the operator-controlled validation plan without weakening mandatory checks?
- Does the validation plan's `units` manifest use the decomposition's stable Unit IDs, cover all required work
  (including infrastructure/cross-cutting Units) with concrete obligations, and can each Unit's readiness checks pass
  with only that Unit and its dependencies implemented?
- Are human edits, context, prior answers and rejection feedback actually reflected?
- Are settled answers reused without rephrased confirmation questions, and reversible details handled with visible defaults?
- Are facts supported by code citations and assumptions visibly distinguished?
- Have all upstream questions been resolved with evidence/answers or retained in the consolidated decision sheet?
- Are high-impact human-only decisions explicitly required rather than silently defaulted?

Return `approve` only when this is a coherent, reviewable proposal. Unanswered decisions that are honestly represented
in the sheet do not prevent reviewability; they still prevent human approval/construction. Return `changes-requested`
for missing content, contradictions, hidden uncertainty or ignored human instructions. Explain actionable findings
in `review-report`. Do not start an interview. Any essential question goes into the recorded result for the sheet.

When the requested output is `planning-review`, its supplied ArtifactType JSON Schema replaces the Markdown report:
- Emit one JSON document with `schemaVersion: "1"`, `summary`, `decisions` and `findings`.
- Classify findings as `research-gap`, `plan-defect`, `human-decision` or `advisory`. Use stable IDs across revisions.
- Claims you confirmed in code go into `verified` with the exact lines, not into findings.
- A `research-gap` is only for a claim the code did not settle. Its `investigation` lists the code you read
  (`checked`) and/or the searches you ran (`searches`), and why that did not settle it. A plan defect names the
  requested correction. Neither is a human question.
- Each finding's `evidence` cites `{ "artifact": { name, resourceVersion } }` from the schema context, or
  `{ "code": { repository, path, startLine, endLine } }` for lines you read. Code locations are checked against the
  pinned workspace; they show where you looked, not that a claim is true. Do not invent evidence.
- Human-only questions must reference a required decision with options and rationale. Reference an existing plan
  decision ID, or define the new decision in `decisions`; do not repeat existing decisions under new IDs.
- `decisions` contains only new, referenced human decisions. Set result `questions: []`; never hide actionable
  questions solely in the summary.
- Set outcome to `changes-requested` if any finding is not advisory, otherwise `approve`. A required decision still
  blocks human approval; research and plan findings remain human-overridable after the bounded repair loop.
- A recorded planning answer is not an executed verification waiver. Never weaken operator policy.
