# ADR-0044: Affected-module verification

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Maintainers
- **Supersedes:** ADR-0042's unconditional full Controlplane build/test requirement only.
  Its required-evidence, approved-plan, freshness and human-gate rules remain in force.

## Context
Controlplane's root Makefile supports `MODULES`, and its CI already maintains a module dependency graph.
Unconditionally building and testing the entire monorepo repeats unrelated setup and integration work,
making even isolated changes consume much of the verification budget. A hardcoded pair of focused modules
does not solve this for other changes, preparation, legacy gates or manual checks.

## Decision
- Add an operator-controlled affected-module policy to Repository and opt named Makefile checks into it.
  The factory selects scope deterministically, never from an agent-provided module list.
- Compare the actual candidate to the Workspace's pinned `baseCommit`: include committed, staged,
  unstaged, deleted, renamed (both paths) and non-ignored untracked changes. Never use only `HEAD` or
  the last developer diff. An unavailable baseline fails visibly rather than guessing.
- Reuse the repository-maintained graph (`name → {path, depends_on}`); select changed modules and the
  transitive closure of their dependents. Build dependencies are still resolved by repository tooling.
  Module paths must be safe relative Make arguments and graph references must be valid.
- Shared tooling, dependency manifests, changed graph/catalog, unknown paths or an empty change set
  use explicit full scope with a recorded reason. Invalid/missing graph data fails visibly. Full scope
  leaves Makefile module discovery intact, including new modules not yet in the graph.
- Operator-declared `nonBuildPaths` (such as documentation) do not expand module selection alongside
  code changes; shared-path rules take precedence. They remain fingerprinted and subject to acceptance
  requirements. Documentation-only changes conservatively validate the full baseline, never an empty suite.
- The same planner/config resolver serves preparation, final verification, recorded agent requests,
  manual standalone checks and legacy automated gates. Non-opted-in checks retain their behavior.
  Explicit full-suite named checks remain available for acceptance scenarios requiring broader coverage.
- Persist resolved scope, baseline and graph hash in immutable CheckRun spec, with the exact executed
  command. Admission and execution revalidate selection; existing snapshot/environment/plan bindings
  continue to prevent stale or forged evidence. Show selected modules or full-scope reason in UI/context.
- Definition changes require a fresh human-reviewed validation plan. Never reinterpret old checks or
  approvals, interrupt active execution, restart an item automatically or lift publication holds.

## Consequences
- AGENTS.md X25 tracks this increment. Affected-module verification is the default for Controlplane
  build/test/preparation checks, not a weaker supplemental substitute for their required evidence.
- The CI graph is repository-maintained policy data and must be kept current by its existing CI checks.
  Changes to graph/catalog or dependency manifests force full validation instead of trusting a stale graph.
- Conservative full scope can remain expensive. Incremental log streaming and agent/check lifecycle
  recovery are separate work; this decision does not hide their existing limitations.
- Port-first implementation, dependency-closure regressions and full-scope safety tests are required.

## Alternatives considered
- Increase timeouts again: preserves unnecessary monorepo work.
- Hardcode rover/rover-server or let the model choose: misses other modules and reverse dependents.
- Always run only directly edited modules: misses consumers of changed shared code.
- Skip unknown paths or treat empty scope as success: could silently verify nothing.
