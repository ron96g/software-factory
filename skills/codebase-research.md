---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: codebase-research
spec:
  description: Locate and summarize the code relevant to a question, with citations.
---

# Codebase Research

1. Extract search terms from the question: domain nouns, endpoints, error messages, symbols.
2. Search the index of every referenced Repository. Read the README and architecture docs first.
3. Follow call paths from the entry points (API, CLI, consumers) to the affected modules.
4. Output `research-notes`:
   - **Summary** (2–3 sentences)
   - **Affected components**, with `repo:path:line` citations
   - **Impact estimate** (S/M/L) and **risks**
   - **Unknowns / open questions** (these can become clarification questions)
