---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: code-review
spec:
  description: Review a change for correctness, design, security, and spec traceability.
---

# Code Review

1. **Correctness:** does the change implement the spec, and handle edge cases and errors?
2. **Design:** does it fit the domain model? Look for unnecessary complexity.
3. **Security:** check inputs, secrets, authz, and dependencies.
4. **Tests:** do they cover the acceptance criteria, and are they meaningful?
5. Report each finding as `blocking` or `non-blocking`, with its location.
6. **Outcome:** `changes-requested` only if there is at least one **blocking** finding (wrong behaviour, missing required
   test, security issue, spec violation). Otherwise `approve`, and list non-blocking points as notes. Never block on style.
7. Make blocking findings **actionable** for the developer: what to change, where (`repo:path:line`), and how to verify it.
