import type { AgentRun, Clarification, FactoryEvent } from "../model/kinds.ts";
import type { EvidenceItem, EvidenceSeverity, GateEvidence } from "../ports/index.ts";

/** Outcome → severity. Unknown outcomes are informational (ok). */
const OUTCOME_SEVERITY: Record<string, EvidenceSeverity> = {
  fail: "blocking",
  failed: "blocking",
  partial: "warning",
  "changes-requested": "warning",
  "needs-info": "warning",
};

const RANK: Record<EvidenceSeverity, number> = { ok: 0, warning: 1, blocking: 2 };
const roundOf = (r: AgentRun) => Number(/-r(\d+)(?:-replay-\d+)?$/.exec(r.metadata.name)?.[1] ?? 0);

/**
 * ADR-0027: pure derivation of gate evidence from the latest round of every step plus check events.
 * Replays never count (they don't change the item).
 */
export function deriveGateEvidence(input: { runs: AgentRun[]; events: FactoryEvent[]; clarifications: Clarification[] }): GateEvidence {
  const items: EvidenceItem[] = [];
  // Evidence recorded before the latest code change is stale (e.g. a check that failed before the developer fixed it).
  const lastCodeChange = input.runs
    .filter((r) => !r.spec.replayOf && r.status?.phase === "Succeeded" && r.spec.outputs?.some((o) => o.name === "source-code"))
    .map((r) => r.status?.finishedAt ?? "")
    .sort()
    .at(-1);
  const stale = (at: string | undefined) => !!lastCodeChange && !!at && at < lastCodeChange;
  const downgrade = (sev: EvidenceSeverity, at: string | undefined): EvidenceSeverity => (sev !== "ok" && stale(at) ? "warning" : sev);
  const staleNote = (at: string | undefined) => (stale(at) ? " (outdated: code changed since)" : "");

  // Latest run per step (highest round), ignoring replays and unfinished runs.
  const latest = new Map<string, AgentRun>();
  for (const r of input.runs) {
    if (r.spec.replayOf || r.status?.phase !== "Succeeded") continue;
    const key = `${r.spec.stage}/${r.spec.step}`;
    const prev = latest.get(key);
    if (!prev || roundOf(r) >= roundOf(prev)) latest.set(key, r);
  }
  for (const r of latest.values()) {
    const outcome = r.status?.result?.outcome;
    if (!outcome || !r.spec.outcomes?.length) continue; // only structured verdicts/decisions count
    const produced = r.spec.outputs?.some((o) => o.name === "source-code");
    const at = produced ? undefined : r.status?.finishedAt;
    const severity = downgrade(OUTCOME_SEVERITY[outcome] ?? "ok", at);
    items.push({
      severity,
      label: `${r.spec.agentRef.name} · ${r.spec.step}: ${outcome}${OUTCOME_SEVERITY[outcome] ? staleNote(at) : ""}`,
      detail: r.status?.result?.summary ?? "",
      stage: r.spec.stage,
      runName: r.metadata.name,
    });
  }

  // Checks: the latest event per check name decides (a later pass clears an earlier failure).
  const checks = new Map<string, FactoryEvent>();
  for (const e of input.events) {
    if (!["CheckPassed", "CheckFailed", "CheckError"].includes(e.spec.reason)) continue;
    const name = e.spec.message.split(/[ :]/)[0];
    const prev = checks.get(name);
    if (!prev || (e.metadata.creationTimestamp ?? "") >= (prev.metadata.creationTimestamp ?? "")) checks.set(name, e);
  }
  for (const [name, e] of checks) {
    const at = e.metadata.creationTimestamp;
    const severity = downgrade(e.spec.reason === "CheckPassed" ? "ok" : e.spec.reason === "CheckFailed" ? "blocking" : "warning", at);
    const verb = e.spec.reason === "CheckPassed" ? "passed" : e.spec.reason === "CheckFailed" ? "failed" : "errored";
    items.push({ severity, label: `Check: ${name} ${verb}${verb !== "passed" ? staleNote(at) : ""}`, detail: e.spec.message.split("\n")[0] });
  }

  if (input.events.some((e) => e.spec.reason === "LoopExhausted")) {
    items.push({ severity: "warning", label: "AI review loop exhausted", detail: "Blocking AI review findings may remain unresolved." });
  }
  const open = input.clarifications.filter((c) => !c.spec.answers?.length);
  if (open.length) items.push({ severity: "warning", label: `${open.length} open clarification(s)`, detail: open.flatMap((c) => c.spec.questions).join(" · ") });

  items.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const status = items.reduce<EvidenceSeverity>((s, i) => (RANK[i.severity] > RANK[s] ? i.severity : s), "ok");
  return { status, items };
}
