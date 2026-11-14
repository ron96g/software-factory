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
3. For each unit, output: a stable ID (`U1`, `U2`, …), name, stories, dependencies (by ID), and an estimated number
   of Bolts. Keep IDs stable across revisions; the validation plan's Unit manifest and the implementation order use them.
