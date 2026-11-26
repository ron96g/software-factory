---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: change-explanation
spec:
  description: Explain a code change in plain language, with Mermaid diagrams and concrete examples, for a reviewer who lacks its context.
---

# Change Explanation

Write for a capable engineer who has **never seen this code base**. They must be able to review the change after reading
your explanation, without asking the author. Explain; do not judge (findings are the reviewer's job).

1. **In one paragraph:** what problem the change solves and what is different afterwards, in everyday words. No
   identifiers in this paragraph.
2. **Background:** only the concepts a reader needs (what a component is for, which data flows through it). Define each
   project term once, citing where it lives (`repo:path:line`).
3. **Before / after diagram:** at least one fenced `mermaid` block (flowchart, sequenceDiagram or stateDiagram-v2)
   showing the affected flow; mark what changed (e.g. a `classDef changed` style or a note). Add a second diagram only if
   it shows something the first doesn't. No ASCII art (ADR-0013).
4. **Worked example:** one concrete input traced through the old and the new behavior (values, request, resulting
   state). Add an edge case if the change targets one.
5. **Walkthrough:** the changed files in reading order, one or two sentences each on their role in the change.
6. **What to look at:** the 3–5 places where a reviewer's attention matters most, and why (risky logic, behavior change
   for callers, missing tests). Phrase them as questions, not verdicts.
7. Ground every statement in the diff or code you read. Say "unclear from the code" instead of guessing intent.
