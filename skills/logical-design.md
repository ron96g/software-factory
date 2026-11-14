---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: logical-design
spec:
  description: Map the domain model onto the existing code - approach, alternatives and per-Unit design notes for human design approval (ADR-0051).
---

# Logical design

Read the approved specification, Units, validation plan, decision answers and research notes, then the code itself.
Add a **Logical design** section to the `domain-model` artifact:

- **Approach:** the recommended design and where it changes the code, with `repo:path:line` citations you actually read.
- **Alternatives:** the realistic options you rejected and why.
- **Per Unit:** the components, interfaces and data each Unit changes, in delivery order.
- **Non-functional concerns:** security, compatibility, migration and observability where they apply.
- **Open points:** anything construction must still discover; never present guesses as researched facts.

A tech lead approves this design before code is written. Stay within the approved scope and decisions: if the design
needs different scope, say so plainly instead of designing it in. Use Mermaid for diagrams.
