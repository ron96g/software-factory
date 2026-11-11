---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: work-item-classification
spec:
  description: Automatically classify a new work item on creation or sync.
---

# Work Item Classification

A fast first pass that runs before triage. Don't research the code in this step.

1. Type: `feature | bug | incident | chore | question`.
2. Priority guess (P0–P3), taken from the source priority and the wording.
3. Labels and affected area. Infer `repositoryRefs` when the source defaults are ambiguous.
4. Output `status.classification`, with a confidence score per field.
