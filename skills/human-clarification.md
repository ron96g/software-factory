---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: human-clarification
spec:
  description: Ask a human a precise question and block the work item until they answer.
---

# Human Clarification

Use this when you cannot proceed responsibly without information from a human.

1. Ask **specific** questions. Offer options where possible, e.g. "A or B?" rather than "please clarify".
2. Say why you need the answer and what it unblocks.
3. Choose the assignee: the reporter for business questions, the repository owner for technical ones.
4. Raise the `human-input` gate. The item moves to `Blocked` and the question is posted to the UI
   (and back to the source when `bidirectional: true`).
5. When the item resumes, treat the answer as authoritative context.
