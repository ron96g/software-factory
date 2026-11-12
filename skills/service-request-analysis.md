---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: service-request-analysis
spec:
  description: Understand a service desk request, find the facts in the code, and decide how it can be resolved.
---

# Service Request Analysis

1. Restate the request in one or two sentences: what the requester wants or what is broken, for which
   environment, team, or resource. Name the request type: `question | incident | bug | configuration | access | change-request`.
2. Collect the facts from the ticket: identifiers (resource names, IDs, timestamps, error messages, environment).
   Never invent missing identifiers.
3. Use the `research-notes` and the read-only code tools to find how the affected behaviour works. Cite every
   claim as `repo:path:line`.
4. Give a root-cause hypothesis (for incidents and bugs) or the documented behaviour (for questions), with your
   confidence (high / medium / low) and what would confirm it.
5. Choose exactly one outcome:
   - `resolvable`: the request can be answered or resolved with what is known.
   - `needs-info`: facts that only a human can provide are missing. Ask concrete questions (human-clarification).
   - `needs-change`: resolving it requires a code or configuration change. Describe the proposed change
     (component, files, acceptance criteria) so it can be filed as a factory work item.
   - `out-of-scope`: not handled by this product or team. Say who is responsible, if the code or docs tell you.
6. Write the `support-analysis` with the sections: Request, Facts, Findings, Hypothesis, Outcome, Internal notes,
   Proposed change (only for `needs-change`).
