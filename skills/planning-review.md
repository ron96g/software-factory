---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: planning-review
spec:
  description: Independently challenge a complete planning bundle before its exact-revision human review.
---

# Planning review

Read the current specification, Units, implementation plan, research and validation plan together.

- Is the outcome understandable without reading transcripts?
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
