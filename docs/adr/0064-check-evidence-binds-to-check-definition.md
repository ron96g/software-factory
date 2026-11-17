# ADR-0064: Check evidence binds to the repository's check definition

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** factory maintainers

## Context
Validation plans (their fingerprint) and every `CheckRun` (`spec.repositoryVersion`) are bound to the Repository's
`resourceVersion`, a hash of the whole definition (ADR-0042, ADR-0061). Any edit therefore invalidates an item's
approved plan and all its check evidence, also edits that cannot change a check result. Enabling publication on
`controlplane` (adding `git:`) asked for a plan re-confirmation and made preflight and verification evidence stale for an
item already in `ship`.

The publish stage made it worse: the publication guard reported the stale preflight and blocked the item with a
Clarification, while the in-place preflight refresh (ADR-0042 §4) only ran on stage entry, which never came at the
last stage. Answering the Clarification could not help.

## Decision
1. **Check definition version.** A Repository's check definition is `local`, `workspace`, `sandboxRef`, `checks`,
   `moduleScope` and `verification`. Its version is a digest of these fields (`checkDefinitionVersion`). Validation plan
   fingerprints, `CheckRun.spec.repositoryVersion`, CheckRun admission and execution, evidence freshness, unit
   readiness and recovery-check authorization all use it. `git`, `index`, `context`, `observability` and metadata
   (labels, annotations) are not part of it: editing them changes no approved plan and no evidence.
   Sandbox profile versions and the environment stay bound separately, as before.
2. **Refresh before publication.** When the publication guard finds the preflight stale, `PublicationRecovery`
   reruns it in place at the current stage, within its budgets, exactly as stage entry does. A human is asked only when
   the refresh cannot run or fails. `recover` is the one member of the publication path with a side effect; it stays
   idempotent (deterministic check keys, `wait` while a check is active). The guard (`check`) stays side-effect free.

## Consequences
- Publication, search and context settings can be changed while items are in flight.
- Rolling this out changes the version format once: existing plans need re-confirmation and existing evidence is stale
  once, after which only real check-definition changes invalidate it.
- A new Repository field that influences what a check runs must be added to the check definition. The function sits
  beside the check configuration (`web/src/core/checks/`) for that reason. Example: once an isolated runtime prepares
  workspaces by cloning `git.url`, the URL becomes part of it.
- Fields are digested with sorted keys, so reordering YAML keys is not a change.
- Amends ADR-0061 ("changing a definition changes `repositoryVersion`") and ADR-0042 §4 (where the preflight refresh
  runs). ADR-0062's worker rule ("definitions older than a run's pinned `repositoryVersion`") now reads as the check
  definition version. AGENTS.md: X44.

## Alternatives considered
- **Keep the whole-definition version and migrate evidence on harmless edits.** Every edit would need a rule for
  whether it is harmless; that is the same field list, applied later and less visibly.
- **Opt-in exclusions per field in the definition.** Lets a definition weaken its own evidence binding. The set of
  check-relevant fields is a property of the factory, not of a repository.
- **Answering the publication Clarification reruns preflight.** Still stops the item for a human although nothing
  needs a decision.
