---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: test-driven-development
spec:
  description: Red-green-refactor implementation loop.
---

# Test-Driven Development

1. Derive test cases from the acceptance criteria. If the repository has an acceptance suite (see its AGENTS.md, e.g.
   `web/src/acceptance/*.acceptance.test.ts`), add one acceptance test per criterion you deliver, named with its ID.
2. Write a failing test (red).
3. Write the smallest change that makes it pass (green).
4. Refactor and keep the tests green.
5. Repeat until every acceptance criterion is covered.
6. If a `code-review-report` is among your inputs, fix **every blocking finding** first and say in your summary how each
   one was addressed. Don't touch unrelated code.
7. If you have a Unit assignment, cover every obligation of that Unit before finishing. Return the `unit-result`
   artifact (JSON, format in your context) with one entry per obligation and the workspace files that prove it.
   Failing readiness checks or missing obligations come back to you; review starts only once every Unit is ready.
