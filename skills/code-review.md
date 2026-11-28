---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: code-review
spec:
  description: Review a change for correctness, design, security, and spec traceability.
---

# Code Review

0. **Scope:** review the whole candidate against the complete approved plan and every Unit, not only the latest
   change or fix. Missing approved behavior is a blocking finding, even when checks pass and even if the latest
   slice is well done. Readiness checks are construction evidence, not proof of correctness.
   When your context has a **change manifest**, the diff is not in the prompt: read every in-scope file with
   `read_change` and acknowledge it with `acknowledge_change` before you finish (ADR-0095). Findings may only name
   changed files you reviewed; a finding about untouched code names that file instead.
1. **Correctness:** does the change implement the spec, and handle edge cases and errors?
2. **Design:** does it fit the domain model? Look for unnecessary complexity.
3. **Security:** check inputs, secrets, authz, and dependencies.
4. **Tests:** do they cover the acceptance criteria, and are they meaningful?
5. Report each finding as `blocking` or `non-blocking`, with its location.
6. **Outcome:** `changes-requested` only if there is at least one **blocking** finding (wrong behaviour, missing required
   test, security issue, spec violation). Otherwise `approve`, and list non-blocking points as notes. Never block on style.
7. Make blocking findings **actionable** for the developer: what to change, where (`repo:path:line`), and how to verify it.
   In a `code-review-report`, that is `path`, `line`, `message` and `fix`; the verdict equals your outcome.
