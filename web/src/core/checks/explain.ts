import type { CheckRun, CheckRunStatus } from "../model/kinds.ts";

/**
 * What a human needs to act on a check that did not produce a usable result, without opening the CheckRun: what
 * happened, the likely cause and what to do about it, the scope it ran on and the end of its output. The text is
 * derived from the recorded status only, so every block, recovery or question that cites a CheckRun says the same.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeWorkspaceChanges(changes: NonNullable<CheckRunStatus["workspaceChanges"]>, limit = 5): string {
  const shown = changes.files.slice(0, limit).map((f) =>
    `${f.change} ${f.path}${f.added === undefined ? "" : ` (+${f.added}/−${f.deleted})`}`);
  const more = changes.total - shown.length;
  return `${plural(changes.total, "file")}: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

interface Diagnosis { what: string; hint?: string }

const mutated = (run: CheckRun) => !!run.status?.workspaceChanges || /modified the workspace/.test(run.status?.message ?? "");

/** The likely cause of a check result that cannot be used as evidence, and the action that resolves it. */
export function diagnoseCheckRun(run: CheckRun): Diagnosis {
  const s = run.status;
  if (!s || s.phase === "Running") return { what: "The check has not finished." };
  if (s.phase === "Interrupted") return { what: "The check was interrupted before it finished (worker restart or lost lease).",
    hint: "This is usually transient and is retried. If it repeats, check that the check worker stays up for the check's duration." };
  if (mutated(run)) {
    const ran = s.executionOutcome ? `The command finished as ${s.executionOutcome}` : "The command ran";
    return {
      what: `${ran}, but it wrote to the candidate${s.workspaceChanges ? ` (${describeWorkspaceChanges(s.workspaceChanges)})` : ""}. ` +
        "A check must leave the candidate unchanged, so the files were restored and the result is not evidence.",
      hint: "The candidate is missing files the check regenerates: typically generated code that is out of date with its " +
        "generator or inputs (a generator version bump, a changed spec or API type), or a generator whose output is not " +
        "reproducible (timestamps, unordered output). Retrying gives the same result. Commit the regenerated files — in the " +
        "candidate, or on the base branch if the base already has the drift — or make the generation reproducible.",
    };
  }
  if (/workflow origin changed/.test(s.message ?? "")) return { what: "The workflow changed while the check ran, so its result belongs to an outdated run.", hint: "It is rerun for the current workflow state." };
  if (s.logsIncomplete && s.executionOutcome === "Passed") return { what: "The command passed but its output was incomplete, so the result could not be confirmed.",
    hint: "Raise the check's `maxOutputBytes` or make the command less verbose." };
  const minutes = Math.round(run.spec.timeoutMs / 60000);
  switch (s.outcome) {
    case "Passed": return { what: "The check passed." };
    case "TimedOut": return { what: `The command did not finish within its ${minutes ? `${minutes} min` : `${run.spec.timeoutMs} ms`} budget.`,
      hint: `Raise the check's \`timeoutMs\`${run.spec.scope?.modules?.length ? `, or narrow the scope (${plural(run.spec.scope.modules.length, "module")} selected)` : ""}, or find the step that hangs in the output.` };
    case "Cancelled": return { what: `The command was stopped by a signal${s.signal ? ` (${s.signal})` : ""}.`,
      hint: "Usually resource limits (out of memory) or a stopped worker. Check the end of the output." };
    case "Unavailable": return { what: "The command could not be started in the check environment.",
      hint: "Check the sandbox runtime and the tools the repository's profile declares (system health shows tool gaps)." };
    case "SetupFailed": return { what: `A prerequisite of the check is missing (exit ${s.exitCode ?? "unknown"}).`,
      hint: "Install the missing tool or declare it in the repository's `SandboxProfile.spec.tools`; the end of the output usually names it." };
    case "AssertionFailed": return { what: `Tests failed${s.tests?.failed.length ? `: ${s.tests.failed.slice(0, 5).map((t) => `\`${t.name}\``).join(", ")}${s.tests.failed.length > 5 ? `, and ${s.tests.failed.length - 5} more` : ""}` : ""}.` };
    case "FindingsReported": return { what: `The check reported ${s.findings?.length ? plural(s.findings.length, "finding") : "findings"}.` };
    case "UnknownFailure": return { what: `The command failed (exit ${s.exitCode ?? "unknown"}) without a result the factory recognizes.`,
      hint: "The end of the output shows the error." };
    default: return { what: s.message ?? `The check ended as ${s.outcome ?? "unknown"}.` };
  }
}

function scopeLine(run: CheckRun): string | undefined {
  const scope = run.spec.scope;
  if (!scope) return undefined;
  const modules = scope.modules ?? [];
  const listed = modules.length ? ` — ${plural(modules.length, "module")}: ${modules.slice(0, 10).join(", ")}${modules.length > 10 ? ", …" : ""}` : "";
  return `**Scope:** ${scope.mode}${listed}${scope.reason ? ` (${scope.reason})` : ""}`;
}

/** Markdown evidence for one CheckRun. */
export function explainCheckRun(run: CheckRun, opts: { lines?: number } = {}): string {
  const s = run.status;
  const diagnosis = diagnoseCheckRun(run);
  const tail = s?.outputTail?.trim();
  const timing = s?.durationMs !== undefined ? ` in ${Math.round(s.durationMs / 1000)} s` : "";
  return [
    `**CheckRun \`${run.metadata.name}\`** (${run.spec.check}, ${s?.outcome ?? s?.phase ?? "no result"}${timing}): ${diagnosis.what}`,
    diagnosis.hint ? `**What to do:** ${diagnosis.hint}` : undefined,
    scopeLine(run),
    `**Command:** \`${run.spec.command}\``,
    tail ? `**End of the output** (last ${opts.lines ?? 8} lines)\n\n\`\`\`text\n${tail.split("\n").slice(-(opts.lines ?? 8)).join("\n")}\n\`\`\`` : undefined,
    s?.logsIncomplete ? "_The log is incomplete, so this is all the factory captured._" : undefined,
  ].filter(Boolean).join("\n\n");
}

const changeKey = (run: CheckRun) => run.status?.workspaceChanges?.files.map((f) => `${f.change}:${f.path}:${f.added}:${f.deleted}`).join("|");

/**
 * Evidence for a series of attempts of the same check: the latest in full, the earlier ones as one line each, and
 * whether every attempt failed the same way (then retrying without a change is pointless).
 */
export function explainAttempts(runs: CheckRun[], opts: { lines?: number } = {}): string {
  const last = runs.at(-1);
  if (!last) return "No attempt was recorded.";
  const lines = runs.map((run, i) => `${i + 1}. \`${run.metadata.name}\`: ${run.status?.outcome ?? run.status?.phase ?? "no result"}` +
    `${run.status?.durationMs !== undefined ? ` after ${Math.round(run.status.durationMs / 1000)} s` : ""}` +
    `${mutated(run) ? ", modified the workspace" : ""}`);
  const same = runs.length > 1 && runs.every((r) => r.status?.outcome === last.status?.outcome && mutated(r) === mutated(last) &&
    changeKey(r) === changeKey(last));
  return [
    `**Attempts**\n${lines.join("\n")}`,
    same ? "Every attempt ended the same way, so the cause is deterministic: another retry without a change will not help." : undefined,
    explainCheckRun(last, opts),
  ].filter(Boolean).join("\n\n");
}
