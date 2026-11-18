import type { CheckRun } from "../model/kinds.ts";

const EXIT_CODE_FORMAT = "exit-code";

/** ADR-0067: a pass whose logs are incomplete still counts when the verdict is the exit code alone and the snapshot is unchanged. */
export function countsAsPassed(run: CheckRun): boolean {
  const status = run.status;
  if (status?.phase !== "Completed" || status.outcome !== "Passed") return false;
  if (status.finalSnapshot !== run.spec.snapshot) return false;
  return !status.logsIncomplete || (run.spec.resultFormat ?? EXIT_CODE_FORMAT) === EXIT_CODE_FORMAT;
}
