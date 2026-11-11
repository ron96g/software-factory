---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: unit-decomposition
spec:
  description: Group user stories into independently deliverable Units of Work.
  requires:
    - name: domain-driven-design
---

# Unit Decomposition

1. Cluster stories by bounded context (see `domain-driven-design`).
2. Minimize cross-unit dependencies and make the ones that remain explicit.
3. For each unit, output: name, stories, dependencies, and an estimated number of Bolts.
