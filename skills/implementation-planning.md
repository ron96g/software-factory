---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: implementation-planning
spec:
  description: Synthesize a readable research-backed implementation plan and one consolidated human decision sheet.
---

# Implementation planning

Research before asking. Read the current specification, Units, validation plan, research notes, human edits and decision
answers. Produce the requested `implementation-plan` artifact as **only a JSON object**:

```json
{
  "outcome": "Short explanation of what will be different.",
  "scope": "Markdown: included work and explicit exclusions.",
  "approach": "Markdown: the recommended approach, alternatives and code citations.",
  "delivery": "Markdown: ordered Units, dependencies and a testable result for each.",
  "acceptance": "Markdown: acceptance criteria, exact named checks, missing evidence and any manual verification.",
  "risks": "Markdown: risks, mitigations and clearly labeled assumptions.",
  "decisions": [
    {
      "id": "stable-decision-id",
      "question": "A decision only a human can responsibly make?",
      "options": ["Option A", "Option B"],
      "recommendation": "Option A",
      "rationale": "Why this matters, the tradeoffs and which work depends on it.",
      "required": true
    }
  ]
}
```

Every section is required and contains Markdown. Keep the summary short and use progressive detail. Use Mermaid
only where it improves comprehension. Never invent researched facts, estimates or completed verification.

Collect all upstream human-only uncertainties. An upstream question that cites a decision ID (`OD-1: …`) is answered
through that decision; keep its ID stable so it is not shown twice. Carry them into decisions or resolve them using authoritative human
answers/evidence, explicitly explaining the resolution in the relevant section. Aim for three to five consequential
decisions; never hide additional essential blockers to meet a limit. Use `decisions: []` when none are necessary.
Preserve IDs/questions/options when semantics are unchanged, including IDs in the human's saved decision ledger.
Resolve discoverable facts before the first review and reuse settled answers; do not split an answered decision into
further confirmation questions. Resolve reversible implementation details autonomously with visible defaults.
Only genuinely new consequential human-only uncertainty should return as a required decision on the same sheet;
it is directly answerable without reopening discovery.
Required decisions have no implicit answer. Optional reversible choices must have an explicit recommendation.
`recommendation` must be copied verbatim from `options` (put the justification in `rationale`); for optional
decisions it becomes the applied default, so a recommendation that is not exactly one option makes the plan invalid.
Do not delegate privacy, destructive actions or other high-impact policy choices to an assumed default.

Human section edits and bundled feedback are instructions for a new proposal, not approval. Keep the implementation
plan consistent with the new specification, Units and policy-controlled validation plan. The independent reviewer
must check those relationships before the human approves. Do not start a sequential interview or implement code.
