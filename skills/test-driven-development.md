---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: test-driven-development
spec:
  description: Red-green-refactor implementation loop.
---

# Test-Driven Development

1. Derive test cases from the acceptance criteria.
2. Write a failing test (red).
3. Write the smallest change that makes it pass (green).
4. Refactor and keep the tests green.
5. Repeat until every acceptance criterion is covered.
