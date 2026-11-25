# ADR-0061: Verification tiers and side-effect-free checks

- **Status:** Accepted
- **Amended by ADR-0080 §10:** the `host` runtime was removed; "runtimes without isolation" in this ADR now means `none` (which executes nothing).
- **Amended by:** ADR-0064
- **Amended by ADR-0089 §1:** dependency manifests and a changed module graph no longer force `full` scope; the graph is read from the base commit.
- **Date:** 2026-11-17
- **Deciders:** project owner
- **Amends:** ADR-0042 §4 (check side effects), ADR-0044 (scope selection), ADR-0047 (readiness checks)
- **Related:** ADR-0062 (check worker, proposed)

## Context
An item on the `controlplane` Go monorepo stayed in "checking" for a long time while the factory server ran at
80–100% CPU. Profiling and the check logs showed these causes:

1. **The same command under several names.** `focused-tests`, `unit-tests` and `full-tests` all run
   `make test-all`, and `build` and `full-build` both run `make build-all`. Whether a check covers affected modules or
   everything is a per-check flag (`moduleScoped`). The resolved scope (`ModuleCheckScope.mode`) knows only
   `affected` and `full`. So the per-Unit readiness check (ADR-0047) runs changed modules plus all transitive
   dependents (11 modules for the investigated item) after every Unit.
2. **Check commands do work that doesn't belong to verifying (observed in the investigated repository).** Each
   `controlplane` module's `test` target runs `manifests generate fmt vet` and then tests with `-race` and
   cross-package coverage. The controller already turns a *passing* check that changed the candidate into
   `NotVerified`, so this is mainly a cost problem. Every readiness run pays for code generation and race-instrumented
   builds.
3. **Caches are implicit and unmanaged.** On the host runtime commands keep `HOME`, so Go's default build cache
   persists across runs, but implicitly: no definition declares it and nothing separates writers. Isolated runtimes
   would start cold every time. Caches also cross a trust boundary: candidate code (written by agents) runs inside
   checks and can write to them.
4. **Checks run inside the web server.** This is covered by ADR-0062.

## Decision
### 1. Tiers decide scope; check definitions decide what runs
- A Repository's check definitions say **what** runs: command, timeout, result format, and whether the command
  accepts a module selection (`scoped: true`). Aim for one definition per kind of evidence (`build`, `tests`, …), not
  one per scope.
- The verification policy assigns checks to **tiers**. The tier gives a scoped check its scope:

| Tier | Existing list / CheckRun purpose | When | Default scope |
|---|---|---|---|
| `readiness` | `readinessChecks` / `unit-readiness` | after each Unit and at the pre-review barrier (ADR-0047) | `changed` |
| `preparation` | `preparationChecks` / `preparation` | when the candidate is prepared (ADR-0043) | `affected` |
| `verification` | `requiredChecks` / `verification` | once per candidate, before human review (ADR-0042) | `affected` |
| `publication` | new `publicationChecks` / new purpose `publication` | before publishing | `full` |

  `preflight`, `diagnostic` and `baseline` runs keep their current, unscoped behavior.
- `changed` is a new scope mode: the modules whose files changed against the Workspace's pinned base, without
  dependents. It follows every ADR-0044 rule otherwise. Shared paths, dependency manifests, unknown paths, a changed
  graph and empty change sets select `full` with a recorded reason, in every tier. `changed` only drops dependents,
  never changed modules.
- The tier-to-scope defaults are data in the verification policy, not code branches (rule 4). Policy may raise a
  check's minimum scope per tier, e.g. `minScope: { verification: { tests: full } }`, which replaces today's
  separate `full-tests` definitions. The check lists themselves stay plain names. Policy can never lower a scope below the tier's default.
- **Evidence identity is `(repository, check, definition version, tier, resolved scope mode, snapshot)`.** A result
  satisfies a requirement only if it is bound to the required snapshot, was produced by the same check definition
  version, its resolved scope is at least the required one (`changed` < `affected` < `full`), and its tier is the
  same or **higher** (`readiness` < `preparation` < `verification` < `publication`). Lower-tier evidence never
  satisfies a higher tier, whatever its scope: lower tiers may use reusable caches (§3). Plans and evidence queries
  carry the tier.
- `changed` scope at readiness means the pre-review barrier no longer exercises unchanged dependents. Only the
  `verification` tier covers them, and that is the gate evidence.
- **Publication tier.** `publicationChecks` run on the exact snapshot that would be published. That is after
  base-branch reconciliation (ADR-0053) and after the last human approval before publication. They run before any
  outbox message is enqueued (ADR-0023), and again on every re-entry of the publish stage (ADR-0054). A snapshot
  change after that approval invalidates the approval, as for any reviewed candidate. They are mandatory unless listed
  in `waivableChecks`. A missing, failed or `NotVerified` result blocks publication and follows ADR-0042's outcome
  rules (code failures return to implementation within the existing budgets and need a fresh approval, everything
  else needs attention). They add evidence and never replace the `human-approval` gate (rule 8). An empty
  `publicationChecks` list leaves publication unchanged. The CheckRun `purpose` union and the origin rules
  (`checks/origin.ts`) gain `publication`.

### 2. Checks do not change the workspace
- A check must leave the candidate as it found it. Today only a *passing* check that changed the workspace becomes
  `NotVerified`. This now applies to every outcome: a failure observed while the check rewrote the candidate is not
  trustworthy code feedback either. The result is `NotVerified` with the reason "check modified the workspace". It
  needs attention like `SetupFailed` (ADR-0042 §3): no code-fix budget is charged, and an unchanged repeat escalates
  instead of looping.
- Detection is limited to what the fingerprint covers (tracked and non-ignored files). Writes to ignored paths
  (`bin/`, `build/`) are not detected. Commands must not rely on such paths for evidence (see §3).
- Work that inherently writes (code generation, formatting) becomes its own check with `isolated: true`. It runs on
  an isolated copy of the candidate and fails when its output differs (e.g. "generated code is out of date"). Writes
  to its own copy don't count as modifying the workspace. `isolatesCandidate` on an `ExecutionEnvironment` means only
  that the candidate runs on a throwaway filesystem copy and cannot modify the live Workspace. It says nothing about
  process isolation or caches, which `SandboxHealthInfo.isolation` still reports. The host runtime sets it once its
  candidate-mode `prepareIsolated` exists: clone `baseCommit`, apply the fingerprinted tree, verify the tree hash.
  Until then `isolated` checks resolve to `Unavailable` and are shown as such. They never run on the live workspace.
- Race detection, coverage and similar expensive options belong in checks that only higher tiers list. That is
  repository configuration, not a factory rule.
- **Implementation note (this change).** The "must leave the candidate as it found it" rule is enforced by a
  `WorkspaceCheckpoint` port: the check controller captures the working tree before a check (as a Git tree object in
  the workspace's own object store, so the handle survives a restart) and, when the check changed the workspace,
  restores the paths it changed and removes the files it added, then reports `NotVerified` with "check modified the
  workspace" for **every** outcome. The restore refuses to touch a path whose deepest existing ancestor resolves
  outside the workspace (a check could otherwise replace a directory with a symlink and redirect the write). The
  checkpoint dependency is optional in the controller: without it, mutation is still detected, just not undone.
  Writing loose objects into the candidate's object store is deliberate (durability) and is bounded by the check's
  own window. Isolated candidate copies (`isolated` checks, X41b) remain the longer-term mechanism.

### 3. Caches are declared, partitioned and never trusted for evidence
- `SandboxProfile.spec.caches` declares named caches, each with a **kind**:
  - `content`: downloads verified against data outside the candidate's control (e.g. Go modules). They are populated
    only by preflight, which runs no candidate-controlled command, and are mounted read-only during checks. They may
    be shared per (repository, profile, cache). Where a runtime can't enforce read-only, they are treated as `result`
    caches.
  - `result`: build or test results keyed by inputs (e.g. `GOCACHE`). Candidate code runs in the check and can write
    to them, so they can be poisoned.
- Cache directories always lie outside the workspace. Runtimes provide them and set the declared variable (e.g.
  `GOCACHE`). Each is a plain directory an operator can delete.
- Per tier:
  - `readiness` runs reuse one `result` cache per WorkItem. They aren't authoritative and can never satisfy a higher
    tier (§1), so a poisoned entry costs at most a misleading readiness result, which verification catches.
  - `preparation`, `verification` and `publication` runs are authoritative. Each CheckRun gets a fresh, empty
    `result` cache that is deleted afterwards. The expensive authoritative runs pay full price once per candidate;
    the frequent readiness runs get the speed.
- Agent runs (OpenCode or tool loop) get their own per-item caches and never a check's cache directories.
- Tool binaries a check depends on (e.g. envtest's `kube-apiserver`) are installed by preflight into a declared
  `content` cache and verified against a checksum from the Repository definition, never one from the candidate. They
  are never taken from an ignored workspace path.
- On runtimes without isolation (`host`) every directory is reachable by the same OS user, so read-only mounts and
  partitioning are nominal there. That is recorded as a residual risk next to ADR-0020's; only isolated runtimes give
  the guarantee.

### 4. Compatibility
- A legacy definition with `moduleScoped: true` keeps today's behavior: `affected`, also in `readiness`. Tier scopes
  apply only to checks that declare `scoped: true`. A legacy check in `publicationChecks` or with `minScope: full` is
  a validation error: the validator rejects every combination in which legacy behavior would run narrower than the
  tier requires. It warns about `moduleScoped`, and the docs describe the migration.
- `scoped: true` keeps today's constraints for module-scoped commands: a single `make <target>` and a `moduleScope`
  policy on the Repository.
- Changing a definition changes `repositoryVersion` (since ADR-0064: only changes to the check definition do). As today, checks pinned to an older version end as "definition
  changed" and approved plans need fresh review (ADR-0044); old checks and approvals are never reinterpreted.

## Phases (AGENTS.md X41)
- **X41a:** tiers, `changed` scope, evidence identity with tier, `minScope`, legacy compatibility.
- **X41b:** "no workspace modification" for every outcome. Isolated candidate copies on the host runtime and
  `isolated` checks.
- **X41c:** declared, partitioned caches.
- **X41d:** publication tier (after the publish-stage ordering above is implemented).

Each phase has its own exit criteria. Required tests:
- lower-tier evidence is rejected at verification, including full-scope readiness evidence on the same snapshot;
- same-tier evidence with a narrower resolved scope than required is rejected;
- legacy `moduleScoped` keeps `affected` and is rejected in `publicationChecks`;
- a failing check that modified the workspace is `NotVerified` and doesn't charge the code-fix budget;
- `isolated` checks are `Unavailable` without candidate isolation, and run on host once X41b is done;
- a readiness run cannot seed a verification run's result cache, and an authoritative run's cache is gone afterwards.

## Consequences
- Per-Unit feedback gets cheap (changed modules, warm item-local cache) while gate evidence keeps ADR-0042/0044
  strength. Configurations shrink to one definition per kind of evidence.
- Verification runs stay expensive by design: they run once per candidate without result-cache reuse.
- `controlplane` gets side-effect-free commands (via upstream Make targets, or a script kept with the factory's
  Repository definition), plus an isolated `generated` check once X41b is in place.
- New schema fields: `scoped` and `isolated` on checks; tier lists with optional `minScope`; `publicationChecks`;
  `caches` on SandboxProfile; scope mode `changed`; tier on CheckRun origins and validation-plan entries.
  `ModuleScopePlanner` gets the tier (or a new narrow port) rather than a method used by one adapter (rule 2).
  `validate.py`, the JSON schemas, `verificationPolicyGaps` and the verification context text need updates.
- When accepted: AGENTS.md X41 status, ADR-0042/0044/0047 get "Amended by ADR-0061" notes, and `docs/architecture.md`
  and the glossary are updated.

## Alternatives considered
- **A `moduleScope: changed` flag per check:** fixes one symptom, adds another per-check flag and keeps duplicated
  definitions.
- **Package-level scoping inside the factory:** rebuilds per language what build tools and their caches do.
- **One shared cache for everything:** fastest, but candidate code or agents could fake evidence through it.
- **Let checks write and re-fingerprint afterwards:** hides that the tested code is not the reviewed code
  (ADR-0042 §4).
