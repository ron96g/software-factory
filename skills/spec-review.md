---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: spec-review
spec:
  description: Review a spec and its units for completeness and testability.
---

# Spec Review

- Is every story testable, with Gherkin acceptance criteria?
- Are the NFRs and risks explicit?
- Are the Units independent, with their dependencies stated?
- List any ambiguities as questions for the human reviewers.
