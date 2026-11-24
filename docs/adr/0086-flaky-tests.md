# ADR-0086: Name failing tests and recognize flaky ones

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** project owner
- **Extends:** ADR-0042 (check runs), ADR-0047 (unit readiness), ADR-0059 (recovery), ADR-0067 (routing by cause)

## Context
`real-kubernetes-cr-backend` blocked several times during unit readiness with:

> `software-factory/unit-tests: UnknownFailure after 2 readiness execution attempt(s). No code fix was charged.
> Inspect CheckRun …, fix prerequisites or budget, then answer to retry.`

The change under test was fine. Each attempt failed on a different test of the repository's own suite, and the failing
test passed in the other attempt (396 tests, 2 failing at random):

| Attempt | Failed | Cause |
|---|---|---|
| 1 | `ADR-0053: a parallel change on main …` | temp-folder cleanup raced git's background writes (`ENOTEMPTY`) |
| 2 | `ADR-0076: without an LLM, drafting …` | a timing assumption ("the item settles within 100 ms") that fails under load |

Three things made this a human question:

1. **The check only reports an exit code.** `unit-tests` runs `npm test` with the `exit-code` classifier, so every red
   run is `UnknownFailure`. The factory never learns which tests failed. The existing `node-test-tap` classifier
   would not help either: it only accepts failures that are `AssertionError`s, and both failures were other errors
   thrown inside tests.
2. **"Different test each time" is invisible.** Two attempts on the same snapshot that fail on different tests are
   strong evidence of flakiness, but the factory compares exit codes only.
3. **Readiness ends in a retry question.** ADR-0067 §1 removed "inspect and retry" questions, but the readiness path
   still asks one when the execution budget is used up and recovery does not take over. A human can only answer
   "retry", which is what the factory could have done itself.

Both flaky tests have been fixed (`fs.rm` retries `ENOTEMPTY`; the drafting test refreshes a stale revision like the
dialog does). But every suite gets flaky tests eventually, in this repository and in the ones the factory works on.

## Decision

### 1. Test checks report per-test results
- `node-test-tap` reports **every** leaf test (`TestResultExtractor` port), not only assertion failures. A test's
  identity is its **name path** (`suite › test`): Node's TAP output names the file only for failures (`location`),
  so the file is recorded for failed tests only.
- **Any failure raised by test code** (`failureType: 'testCodeFailure'`, whatever the error type) is a named test
  failure, classified `AssertionFailed`, which ADR-0067 already routes to the code-fix loop and recovery. Hook failures
  (`hookFailed`), crashed files (a result carrying `exitCode`), cancellations, a missing summary or truncated output
  stay `UnknownFailure` / `NotVerified`. Output on stderr no longer decides anything.
- The CheckRun records `status.tests`: failed tests in full (name, workspace-relative file, and `touched`: the
  candidate changed or added that file, from the new `CandidateChanges` port), passed tests as short hashes of their
  name paths, and the skipped count. Names must survive redaction unchanged, and more than 200 failures record no
  test list. Every run that doesn't pass also keeps `status.outputTail`: the last 2,000 redacted characters.
- The `software-factory` repository runs `unit-tests`, `integration-tests` and `acceptance-criteria` with
  `node --test --test-reporter=tap` and `resultFormat: node-test-tap`.

### 2. Flakiness is a decision over the attempts of one snapshot
A test check is **flaky** on one snapshot when all of the following hold:

- every full attempt has complete per-test results (§1) and failed only with named failures; no attempt is
  `UnknownFailure`, `NotVerified`, truncated or has incomplete logs;
- the full attempts share snapshot, command and scope;
- every failed test **passed in another full attempt, or in a targeted re-run of the attempt it failed in** (§3);
- the candidate changed none of the failed tests' files (`touched: false`; an unknown file counts as touched). A flaky
  test the change touched may be one the change broke, so it goes to the developer.

Two tests with the same name path in different files can't produce a false verdict: a run only counts as a witness
when it did not fail that name itself.

It is a decision over CheckRuns (`flakyEvidence`), not an outcome of a single run: every CheckRun keeps its own
classification, and the unit progress shows the check as `Flaky`. A test that fails in every run is never flaky.
Rule 8 and ADR-0067 §3 stay intact: flakiness is proven on the candidate's own snapshot, not by comparing commits,
and it never makes a failure "pre-existing".

### 3. Confirm before charging a code fix
When the latest attempt failed only on untouched named tests and nothing explains them yet:

- If the repository declares a targeted re-run, the gate runs **only the failed tests** once on the same snapshot:
  ```yaml
  checks:
    unit-tests:
      command: cd web && node --test --test-reporter=tap "src/**/*.test.ts"
      resultFormat: node-test-tap          # required for rerunFailed
      rerunFailed: node --test --test-reporter=tap --test-name-pattern="$FACTORY_RERUN_PATTERN" $FACTORY_RERUN_FILES
  ```
  The command runs from the workspace root. Test names and files come from workspace output, so they are untrusted:
  they reach the shell only as **single-quoted values of exported variables** in the command's preamble (the sandbox
  runners don't pass environment variables), never as command text. The pattern is an anchored, escaped alternation
  of each failed test's name path **and its ancestors**, joined by spaces as Node matches them, so the enclosing
  tests run. Files must be workspace-relative paths matching `[A-Za-z0-9._/-]+` without `..`, and at most 50 tests
  are re-run; a file may not start with `-` (it would become an option). Otherwise there is no targeted re-run. At
  `verify`, a re-run is only requested for an attempt on the current snapshot.
- The re-run is a CheckRun with purpose `rerun-failed` and `rerunOf` naming the attempt. The scheduler, admission and
  controller derive its command from the attempt's recorded failures (never from a caller). It is evidence for
  flakiness only: `countsAsPassed` never counts it and its `Verified` condition is never `True`, so a partial run can
  never satisfy the check.
- Without `rerunFailed`, the next full attempt (within `maxExecutionAttempts`) serves as the confirmation.
- If the failures stay unexplained after the attempts, the original outcome stands: `AssertionFailed` goes to the
  code-fix loop or recovery as before.

### 4. What flaky does, by stage
| Where | Effect |
|---|---|
| Unit readiness and the pre-review barrier (ADR-0047) | Counts as ready: the Unit ledger and the barrier's current-candidate evidence both accept flaky evidence on the current snapshot. Readiness is never final verification, and `verify` runs the full suite again. |
| Final verification (`verify`) | **Transient** (ADR-0067 §1): the full check runs again, with the retry delay, while attempts remain. Any clean pass on the snapshot is `Passed` as today. When the attempts are used up and the check is still flaky, it goes to the **waiver approval** (ADR-0067 §5), also for checks that are not in `waivableChecks`: a human decides, and it is Waived, never Passed. |
| Policy | `autoWaive` accepts `when: flaky` (rule 4) for checks in `waivableChecks`, recorded as a policy waiver naming the flaky tests. |
| Preflight and preparation checks | Unchanged (no per-test evidence in this repository). |

### 5. Opaque failures ask with evidence
When readiness attempts are used up on a failure that is not a named test failure (e.g. a crashed file, a hook, a
missing tool) and no recovery policy takes over, the item still needs a human, because only a human can tell an
environment problem from a change-caused crash. The question now says which decision is needed (fix the environment
and run again, or tell the developer what to fix) and shows the evidence in its details: the failed tests, if any,
and the end of the output. Named test failures and flaky checks never reach this question.

### 6. Flaky tests become work, not noise
- Every flaky decision records one Warning event per test (`FlakyTest`, `<repository>/<check> › <test>`, naming the
  runs). Reporting the same decision again records nothing.
- When the same test has **3** flaky decisions within 7 days (across items), the factory proposes one tracker issue
  ("Flaky test: `<name>`", with the evidence), purpose `finding`, to the repository's `issueTrackerRef`, owned by the
  item where the threshold was reached. The proposal name is deterministic per (repository, check, test), so it is
  proposed once. A human approves it as usual (ADR-0066/0068).

## Consequences
- Random failures in a repository's own suite no longer stop items: readiness proceeds with a visible warning, and
  verification re-runs or asks for a waiver with evidence instead of "answer to retry".
- Real failures get better: named failing tests (any error type, not only assertions) go to the developer's code-fix
  loop, as Go repositories already do.
- Repeatedly flaky tests surface as one proposed issue instead of being retried forever.
- Costs: TAP output is larger (about 115 KB for this repository's 396 tests), and a confirmation costs one targeted
  re-run or one more full run.
- Changing the three check commands changes `software-factory`'s check definition version (ADR-0064). Items in flight
  re-confirm their plan once (ADR-0054); their check evidence is collected again.
- Code changes:
  - `TestResultExtractor` and `CandidateChanges` ports.
  - `CheckRunStatus.tests` and `outputTail`.
  - `rerun-failed` origin purpose with `rerunOf`, and `Repository.spec.checks.<name>.rerunFailed`.
  - `flakyEvidence` and `untouchedFailures` in the model.
  - Readiness and verification routing, and `autoWaive when: flaky`.
  - `FlakyTestReporter` port with an event-based implementation.
  - No new resource kind and no new `CheckOutcome`.
- AGENTS.md: item **X66**. Glossary: *Flaky check*, *Targeted re-run*.

## Alternatives considered
- **More execution attempts.** A suite with two independently flaky tests fails often enough that more attempts only
  delay the same question. Attempts also cost the full suite each time.
- **Retry failed tests inside the test runner** (a retry wrapper around `node --test`). Hides flakiness from the factory
  and from the team. A test that passes on its third try is reported as a plain pass.
- **Skip or quarantine flaky tests by configuration.** Useful for a known-broken test, but a static list goes stale and
  hides regressions in those tests. The issue proposal (§6) leads to a fix instead. A quarantine list can be added later
  if a team needs it.
- **Compare with the base commit** (ADR-0067 §3). Rejected for tests by ADR-0067 itself: a change can make a flaky test
  fail for a new reason, and test names alone can't tell. Flakiness is proven on the candidate's own snapshot instead.
- **Treat any failure as flaky when a later attempt passes.** Already the behaviour (any pass on the snapshot counts).
  It doesn't help when every attempt fails on a different test, which is exactly the observed case.
