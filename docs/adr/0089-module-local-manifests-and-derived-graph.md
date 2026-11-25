# ADR-0089: Module-local dependency manifests and the derived module graph do not force full scope

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** project owner
- **Amends:** ADR-0044 (dependency manifests and a changed graph select full scope) and ADR-0061 (the same rule
  applies "in every tier")
- **Related:** ADR-0044 (affected-module policy), ADR-0061 (`changed`/`affected`/`full`, tiers and side-effect-free
  checks), ADR-0047 (per-Unit readiness), ADR-0064 (check-definition version), ADR-0054 (definition-change
  re-confirmation), ADR-0061 §2 (`WorkspaceCheckpoint`, the companion fix that restores a candidate a check rewrote)

## Context

A `factory-plan` item (`file-download-proxy-in-controlplane-api-for-files-stored-in`) adds a public file-download
proxy to `controlplane-api`. Its candidate diff is concentrated in one module plus the module wiring that the change
forces:

- `controlplane-api/**` — the feature (`internal/files/**`, `cmd/main.go`, config, GraphQL schema) and its codegen;
- `controlplane-api/go.mod` / `go.sum` — adding `github.com/telekom/controlplane/file-manager`, which pins newer
  indirect dependencies (`Masterminds/semver v3.5.0`, `pelletier/go-toml v2.3.1`, `klauspost/cpuid v2.4.0`, …);
- `projector/go.mod` / `go.sum` — the same indirect bumps, required because `projector` imports `controlplane-api`
  (`replace … => ../controlplane-api`, and the CI graph already records `projector → controlplane-api`);
- `.github/ci/module-graph.json` — one edge added to `controlplane-api.depends_on`, because that graph is **derived**
  from the go.mod `replace` directives by `.github/scripts/gen-module-graph.sh` and enforced by `make ci-graph-check`.

ADR-0044 and ADR-0061 make this candidate a **full-scope** candidate: a changed dependency manifest or graph forces
`full` "in every tier", and the planner additionally special-cases the graph file itself (`path === policy.graph`).
The observed effect:

- `focused-tests` (`make test-all`) ran **all 27 modules** in every round, command `make test-all` with no `MODULES`.
  Round 18 attempt 1 hit the 15-minute readiness budget and was killed at `900009 ms` (exit 137, cold cache); attempts
  2 and round 19 then passed in 668 s and 484 s once caches were warm. The genuine scope is **2 modules**
  (`controlplane-api`, `projector`); 25 modules are untouched.
- Full scope is not only slow, it **corrupts the candidate**: `organization-server` and `rover-server` run
  `make generate` inside `make build`, so `make build-all` under full scope rewrote their `internal/api/server.gen.go`
  (the first `build` check was `NotVerified … check changed the candidate workspace`). Those files were never part of
  the developer's change, yet they entered the changed set and the module graph.
- The two rules **compound**: because the graph mirrors the manifests, *every* dependency change is also a graph
  change, so "a manifest or graph change forces full" collapses to "any dependency change runs the whole monorepo,
  always".

The rule is over-conservative for a Go monorepo whose modules each own their `go.mod` with local `replace`s:

- a module-local manifest cannot affect a module that does not transitively depend on it, and the graph's dependent
  closure already selects exactly those consumers;
- the graph is a *mirror* of those manifests, not an independent shared artifact;
- ADR-0061's stated goal is cheap per-Unit readiness, which the manifest/graph rules defeat.

The failure modes the rule was meant to prevent (a stale graph under-selecting, an unknown path) are still covered:
an unknown/unowned path forces `full`, and a change set that is only non-build paths still validates the full baseline.

## Decision

1. **A change to a module-local dependency manifest is module-local.** Paths matching `**/go.mod` / `**/go.sum` select
   the owning module and, per the graph, its transitive dependents — `changed` (readiness) or `affected`
   (preparation/verification) — not `full`. Repositories stop listing `**/go.mod` / `**/go.sum` in
   `moduleScope.sharedPaths`. Genuine shared paths still force `full`: the root `Makefile`, `hack/**`,
   `.github/workflows/**`, `.github/scripts/**`, lint/tooling config (`.golangci.yml`, `.ko.yaml`) and root
   `go.work*`.
2. **The repository's derived module graph is metadata, not shared tooling.** `moduleScope.graph` is declared under
   `moduleScope.nonBuildPaths`; it no longer forces `full` and no longer requires a module owner. A change set that is
   *only* non-build paths still resolves to `full`, preserving the "validate the full baseline" rule.
3. **The planner stops special-casing `path === policy.graph`.** The graph is read from the **pinned base commit**
   (`git show <baseCommit>:<graph>`), not the working tree, and fingerprinted into the resolved scope. The graph that
   decides scope is therefore the reviewed one, so a candidate cannot narrow its own scope by editing the graph; a
   graph that is new in the candidate (absent at the base) falls back to the working tree. The declared graph path is
   resolved first, so a graph that escapes the workspace is rejected. Files outside known modules still fail visibly
   to `full`.
4. **Scope selection stays deterministic and factory-owned** (ADR-0044): never from an agent-supplied module list; the
   graph hash, base commit and resolved modules remain pinned in the immutable CheckRun spec.

## Consequences

- Per-Unit readiness for a manifest change now runs only the changed modules — for the investigated item,
  `make test-all MODULES='controlplane-api projector'` — which fits the readiness budget. A graph-only change still
  conservatively validates the full baseline.
- Full runs become the exception (root/CI/lint changes), which is what ADR-0061 intended, instead of the default for
  every dependency change.
- `controlplane`'s `full-build`/`full-tests` become **scoped aliases**: they follow the tier scope (never the whole
  monorepo), kept only so in-flight plans that reference them still resolve; the validation-plan instructions no longer
  ask the planner for explicit full checks, and the aliases can be removed once no open plan references them.
- It removes a class of **candidate corruption**: `build-all`/`test-all` no longer run codegen in untouched modules.
  It does **not** fix the underlying problem that a check may run codegen that rewrites the candidate; that remains
  ADR-0061 §(b) / X41b (writing checks on isolated candidate copies).
- Correctness now depends on the graph being current for a changed manifest. This is already a repository obligation
  enforced by CI (`make ci-graph-check`); a repository that cannot guarantee a current graph must keep the manifest in
  `sharedPaths`.
- Changing `moduleScope` changes the repository's **check-definition version** (ADR-0064), so in-flight plans need
  re-confirmation (ADR-0054) and the running process must reload definitions.
- Follow-ups: ADR-0044/0061 status gains "Amended by ADR-0089"; the AGENTS.md X25 description is updated; a
  regression test asserts a per-module manifest selects `affected`/`changed` while genuine shared paths stay `full`.

## Alternatives considered

- **Increase the `focused-tests` timeout again.** ADR-0044 already rejected this: it preserves the unnecessary
  monorepo work, keeps paying ~8–15 minutes per Unit, and still mutates untouched modules through codegen.
- **Keep the graph shared and drop only `**/go.mod`.** Insufficient: the graph changes with every dependency change,
  so scope stays `full` in practice. It fixes the rule on paper without changing the observed outcome.
- **Exclude generated files (e.g. `*.gen.go`) from the changed set.** Hides real generated changes, does not address
  the dependency cascade, and cannot be done safely without knowing which generated files are trusted.
- **Add a narrower readiness-only check (`make test` in the owning module).** Duplicates evidence definitions per
  module, and leaves preparation, verification, legacy gates and manual checks running the whole monorepo.
- **Trust an agent-provided module list.** Violates ADR-0044 ("the factory selects scope deterministically, never from
  an agent-provided module list").
