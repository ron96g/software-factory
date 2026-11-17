# ADR-0063: Verification evidence is collected before the verifier runs

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** project owner
- **Amends:** ADR-0042 §2 and §4 (who submits verification checks, and when the verifier evaluates them)

## Context
On a verified workflow, the verify stage ran its verifier step first and the `verified-checks` gate afterwards. The
verifier therefore had to produce its verdict before the authoritative checks existed. It tried to fill the gap with
`run_check` and polled inside its run. On `controlplane`, verification checks take 6–8 minutes each and run one at a
time per workspace, much longer than an agent's step budget. In the observed item:
- The verifier finished after about a minute with "PARTIAL: focused-tests still Running".
- Its own check then counted as `NotVerified`, because agent-requested checks are bound to an active caller.
- The gate ran all required checks again afterwards; they passed.
- The human was asked to approve a report that described pending evidence which had since passed.

This contradicts ADR-0042 §4 ("the verifier evaluates evidence against the plan instead of independently deciding
what is sufficient") and rule 6 (no waiting for long work inside a process).

## Decision
- When the verify stage is entered, its stage-entry policy collects the approved plan's verification checks for the
  approved candidate **before** the verifier's AgentRun is created. This is the same pattern as candidate
  preparation (ADR-0043). The WorkItem controller waits durably (requeue), never inside a process.
- The same code serves stage entry and the `verified-checks` gate, with the same request identities, budgets and
  outcome rules (ADR-0042 §3):
  - assertion failures return to implementation within the code-fix budget;
  - other failures are retried within the execution budget, then need attention;
  - unconfigured checks become waiver requirements.
  The gate afterwards only confirms that the evidence is still current for the candidate. If it is not, it
  collects again.
- The verifier receives the current verification evidence (every required check's latest result, scope, snapshot and
  log reference) in its context and evaluates it against the specification and the plan. It no longer starts
  authoritative checks: `run_check` is removed from the verifier. Diagnostics with `run` remain possible and never
  count as evidence.
- Only the verify stage changes. Preflight (gate after its step) and readiness checks (ADR-0047) keep their behavior.

## Consequences
- The verification report describes the evidence the human approves. No authoritative check runs twice for the same
  candidate because an agent's run ended.
- The verify stage takes as long as its checks before the verifier starts. The UI shows the running checks; the item
  stays visibly in `verify`.
- With ADR-0061 (`changed` readiness scope) and ADR-0062 (a check worker), the remaining cost is concentrated in
  this one authoritative collection per candidate, by design.

## Alternatives considered
- **Let the verifier wait longer (more steps, sleeping):** waits inside a process (rule 6) and wastes model calls.
- **Re-run the verifier after the gate:** produces two reports per candidate, and the first one is always
  misleading.
- **Keep `run_check` for the verifier as an optional rerun:** its results end as `NotVerified` once the run ends, so
  they only cost time.
