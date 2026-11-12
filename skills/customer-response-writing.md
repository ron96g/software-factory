---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: customer-response-writing
spec:
  description: Write a clear, correct reply to a service desk requester from an internal analysis.
---

# Customer Response Writing

1. Answer in the language of the ticket. Address the requester's actual question first.
2. Be concrete: steps to resolve, the configuration to use, or what happens next and when.
3. Use only facts from the `support-analysis`. If something is uncertain, say so instead of guessing.
4. Keep internal details out: no file paths, code citations, internal hostnames, team-internal names, or
   confidence ratings. Explain behaviour in product terms.
5. For `needs-change`: confirm the problem, explain the workaround if there is one, and say that a change is
   being tracked. For `out-of-scope`: say who can help, politely.
6. Structure: short greeting, answer, next steps (numbered if more than one), closing. Markdown, no headings
   above level 3. It must be ready to paste into the ticket after a human approves it.
