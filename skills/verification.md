---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: verification
spec:
  description: Verify an implementation against its spec with traceable evidence.
---

# Verification

1. Get build and test results: on verified workflows they are the factory's check evidence ("Current verification
   evidence"); evaluate it and don't rerun it. Otherwise build and run the unit and integration tests yourself.
2. Map each acceptance criterion to a test and its result.
3. Include the security and dependency scan results (run them yourself only where no check evidence exists).
4. Output a `verification-report` with the trace matrix and a pass/fail verdict.
5. **Verdict (outcome)**, exactly one of:
   - `pass`: every acceptance criterion is covered by a passing test or check, and build and tests are green.
   - `partial`: build and tests are green, but some criteria are only verified by inspection or are untested.
   - `fail`: a build or test fails, or an acceptance criterion is violated or clearly unmet.
   Put the verdict first in the report (e.g. `**Verdict: FAIL**`), followed by the reasons. Humans see it at the release gate.
6. Verify; never repair. Do not edit the candidate workspace: any change invalidates the human-approved candidate and
   sends it back through the completeness barrier and review. Report defects for the developer instead.
