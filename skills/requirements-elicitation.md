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

1. Restate the intent in one sentence and confirm it with the human.
2. Identify actors, goals, and constraints.
3. Ask up to 5 clarifying questions. Batch them and wait for answers.
4. Write stories with Gherkin acceptance criteria.
5. List NFRs (performance, security, compliance) and open questions.
