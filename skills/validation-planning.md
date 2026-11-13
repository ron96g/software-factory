---
apiVersion: factory.ai-dlc.io/v1alpha1
kind: Skill
metadata:
  name: validation-planning
spec:
  description: Map every acceptance criterion to operator-approved named checks and same-environment prerequisites.
---

# Validation planning

Read the specification, research and operator-controlled verification policy in the context. Inspect repository
Makefiles and CI before planning. Produce a `validation-plan` artifact containing **only a JSON object**:

```json
{
  "criteria": [
    { "id": "AC-1", "description": "Exact acceptance criterion", "checks": ["repository/check"] }
  ],
  "checks": ["repository/check"],
  "preflight": ["repository/preflight"]
}
```

Use the actual repository and named check identities from policy, not the example placeholders. Include every
mandatory check and preflight; map every criterion and every verification check. Module-scoped checks cover changed
modules and transitive dependents using repository policy, not a model-selected list. Use explicit full checks when
acceptance requires whole-repository coverage; do not add them indiscriminately to duplicate affected-module checks.
Commands, arguments and budgets come from repository configuration,
not this artifact. Identify missing integration/acceptance/security evidence honestly: unsupported named requirements
remain in the plan and cannot pass without evidence or a policy-permitted, explicit human waiver later.

Explain scope, prerequisites and missing evidence in the summary for human review. Human review approves the exact
plan, workflow and repository policy revisions before preflight or construction. Do not edit code or run checks
while proposing the plan.
