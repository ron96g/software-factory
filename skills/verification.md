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
