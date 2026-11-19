---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: issue-proposal
spec:
  description: Propose tracker issues (findings) for problems outside the current work item (ADR-0066).
---

# Issue Proposal

Propose an issue (the `issues` field of your result) only for a **finding** that deserves its own ticket in the team's
tracker and is outside the scope of this work item: a bug you noticed, missing test coverage, a risky dependency,
a follow-up that needs an owner.

Rules:
- A precise title and a Markdown body: what you saw, evidence as `repo:path:line`, and why it matters.
- Only what you verified. No guesses, no customer data, no secrets.
- You never choose the tracker, the project or whether it is picked up. A human picks the target and approves; nothing
  is created before that.
- At most 5 per run are kept. Most runs propose nothing.
- This is not a follow-up work item (ADR-0039); do not use it for work that belongs to this item.
