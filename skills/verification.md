---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: verification
spec:
  description: Verify an implementation against its spec with traceable evidence.
---

# Verification

1. Build and run unit and integration tests.
2. Map each acceptance criterion to a test and its result.
3. Run the security and dependency scans.
4. Output a `verification-report` with the trace matrix and a pass/fail verdict.
5. **Verdict (outcome)**, exactly one of:
   - `pass`: every acceptance criterion is covered by a passing test or check, and build and tests are green.
   - `partial`: build and tests are green, but some criteria are only verified by inspection or are untested.
   - `fail`: a build or test fails, or an acceptance criterion is violated or clearly unmet.
   Put the verdict first in the report (e.g. `**Verdict: FAIL**`), followed by the reasons. Humans see it at the release gate.
