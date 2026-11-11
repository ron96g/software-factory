---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: issue-triage
spec:
  description: Classify, deduplicate, and prioritize an incoming signal.
---

# Issue Triage

1. Classify the type: `feature | bug | incident | chore | question`.
2. Search existing work for duplicates.
3. Set the priority with an impact × urgency matrix (P0–P3).
4. Size the work: `S | M | L`. Size `L` usually means several Units.
5. Choose an outcome: `accept | needs-info | duplicate | reject`, and give a one-paragraph rationale.
