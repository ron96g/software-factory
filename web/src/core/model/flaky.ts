import type { CheckRun } from "./kinds.ts";
import { testId } from "./tests.ts";

export interface FlakyEvidence {
  /** Name paths of the tests that failed in one run and passed in another. */
  tests: string[];
  /** The attempts and targeted re-runs the decision rests on. */
  runs: string[];
}

/** Complete per-test evidence for the snapshot it ran on. */
const complete = (run: CheckRun) => run.status?.phase === "Completed" && !!run.status.tests && !run.status.logsIncomplete &&
  run.status.finalSnapshot === run.spec.snapshot && (run.status.outcome === "Passed" || run.status.outcome === "AssertionFailed");

const isRerun = (run: CheckRun) => run.spec.workflow?.purpose === "rerun-failed";

/** A named failure whose file the candidate did not change (ADR-0079 §2: only such failures can be flaky). */
export const untouchedFailures = (run: CheckRun): boolean => complete(run) && run.status!.outcome === "AssertionFailed" &&
  run.status!.tests!.failed.length > 0 && run.status!.tests!.failed.every((t) => !!t.file && t.touched === false);

/**
 * ADR-0079 §2: a test check on one snapshot is flaky when every named failure passed in another full attempt, or in a
 * targeted re-run of the attempt it failed in, and the candidate changed none of the failed tests' files. Full attempts
 * must share snapshot, command and scope and all carry per-test results; a test that fails everywhere is never flaky.
 * `runs`: completed CheckRuns of one check on one workspace (full attempts and their targeted re-runs).
 */
export function flakyEvidence(runs: CheckRun[]): FlakyEvidence | undefined {
  const attempts = runs.filter((r) => !isRerun(r));
  if (!attempts.length || !attempts.every(untouchedFailures)) return undefined;
  const [first] = attempts;
  if (attempts.some((r) => r.spec.snapshot !== first.spec.snapshot || r.spec.command !== first.spec.command ||
      JSON.stringify(r.spec.scope) !== JSON.stringify(first.spec.scope))) return undefined;
  const reruns = runs.filter((r) => isRerun(r) && complete(r) && r.spec.snapshot === first.spec.snapshot);
  const tests = new Set<string>();
  const used = new Set<string>();
  for (const attempt of attempts) {
    for (const failed of attempt.status!.tests!.failed) {
      const id = testId(failed.name);
      const witness = [
        ...attempts.filter((other) => other !== attempt),
        ...reruns.filter((r) => r.spec.workflow?.rerunOf === attempt.metadata.name),
      ].find((other) => other.status!.tests!.passed.includes(id) && !other.status!.tests!.failed.some((t) => t.name === failed.name));
      if (!witness) return undefined;
      tests.add(failed.name);
      used.add(attempt.metadata.name).add(witness.metadata.name);
    }
  }
  return { tests: [...tests].sort(), runs: [...used].sort() };
}
