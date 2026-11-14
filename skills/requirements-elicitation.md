---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: requirements-elicitation
spec:
  description: Turn a vague intent into precise, testable user stories.
  requires: []
---

# Requirements Elicitation

When the recorded planning contract requests a consolidated decision sheet, draft the specification autonomously
instead of performing steps 1 and 3 as an interview. Use supplied context and decision answers, label assumptions,
and record genuine human-only uncertainties for the shared plan review. Do not silently decide high-impact choices.

1. Restate the intent in one sentence and confirm it with the human.
2. Identify actors, goals, and constraints.
3. Ask up to 5 clarifying questions. Batch them and wait for answers.
4. Write stories with Gherkin acceptance criteria.
5. List NFRs (performance, security, compliance) and open questions.
