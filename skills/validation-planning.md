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
  "preflight": ["repository/preflight"],
  "units": [
    {
      "id": "U1",
      "title": "Short Unit title",
      "dependsOn": [],
      "criteria": ["AC-1"],
      "obligations": [
        { "id": "U1-O1", "description": "Concrete deliverable that proves part of the Unit is done", "checks": ["repository/check"] }
      ]
    }
  ]
}
```

Map operator-mandatory checks (e.g. `build`) to the criteria they support where meaningful; every optional check
must be mapped to a criterion. `units` is required when the workflow enables unit execution (ADR-0047).
Infrastructure Units may have `criteria: []`, but every criterion needs at least one delivering Unit. Use the stable Unit IDs of the
`units-of-work` artifact. Every acceptance criterion needs a delivering Unit; every Unit needs concrete obligations
(including infrastructure and cross-cutting work) and readiness checks from the repository's `readinessChecks`
allowlist that are also listed in `checks`. Dependencies must be acyclic. A Unit's readiness checks must be able to
pass with only that Unit and its dependencies implemented; choose a focused check or change the dependency instead.
Units are implemented one at a time in this order, and review starts only once every Unit is ready.

Use the actual repository and named check identities from policy, not the example placeholders. Map a criterion to
an acceptance check only when the plan says which acceptance test will prove it (named with the criterion ID). Include every
mandatory check and preflight; map every criterion and every verification check. Module-scoped checks cover changed
modules and transitive dependents using repository policy, not a model-selected list. Use explicit full checks when
acceptance requires whole-repository coverage; do not add them indiscriminately to duplicate affected-module checks.
Commands, arguments and budgets come from repository configuration,
not this artifact. Identify missing integration/acceptance/security evidence honestly: unsupported named requirements
remain in the plan and cannot pass without evidence or a policy-permitted, explicit human waiver later.

Explain scope, prerequisites and missing evidence in the summary for human review. Human review approves the exact
plan, workflow and repository policy revisions before preflight or construction. Do not edit code or run checks
while proposing the plan.
