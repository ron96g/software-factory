---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: release-management
spec:
  description: Version, package, and roll out a release with a rollback plan.
---

# Release Management

1. Determine the semantic version and generate the changelog.
2. Choose the rollout strategy (canary or blue-green) and define the success criteria.
3. Write the rollback steps and test them if you can.
4. Output a `release` artifact.
