---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: decision-sheet
spec:
  description: Write the focused implementation plan of a one-planner workflow - plain-language risks and the consolidated human decision sheet only (ADR-0051).
---

# Decision sheet

The specification, Units of Work and validation plan you produce in the same run are what the human reads for
"what" and "how it is proven". The architect designs the "how" later, and a human approves that design separately.
Produce the `implementation-plan` artifact as **only a JSON object** with exactly these keys:

```json
{
  "risks": "Markdown: the few risks, assumptions and open points a reviewer must know, in plain language.",
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

Do not add outcome, scope, approach, delivery or acceptance: that would repeat the other artifacts or anticipate the
design, and the output check rejects it. Write `risks` for a human who has not read the code: short sentences, no
internal IDs without explanation, label assumptions, and say what happens if an assumption is wrong. Keep design
choices out unless a human must decide them before the specification is final.

Collect all upstream human-only uncertainties. An upstream question that cites a decision ID (`OD-1: …`) is answered
through that decision; keep its ID stable so it is not shown twice. Carry them into decisions or resolve them using
authoritative human answers/evidence, explaining the resolution in `risks`. Aim for three to five consequential
decisions; never hide additional essential blockers to meet a limit. Use `decisions: []` when none are necessary.
Preserve IDs/questions/options when semantics are unchanged, including IDs in the human's saved decision ledger, and
reuse settled answers; do not split an answered decision into further confirmation questions.
Required decisions have no implicit answer. Optional reversible choices must have an explicit recommendation, copied
verbatim from `options`; it becomes the applied default. Do not delegate privacy, destructive actions or other
high-impact policy choices to an assumed default.

Human edits and bundled feedback are instructions for a new proposal, not approval. Do not interview the human or
implement code.
