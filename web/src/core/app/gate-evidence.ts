import type { AgentRun, Artifact, Clarification, FactoryEvent } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
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
const VERDICT_ARTIFACTS = new Set(["verification-report", "code-review-report", "review-report"]);

/** Free-text verdict, e.g. "Verdict: FAIL (coverage)", "**Verdict:** partial", "the verdict is FAIL". */
export function parseVerdict(text: string | undefined): "pass" | "partial" | "fail" | undefined {
  const m = text && /\bverdict\b[^a-z]{0,12}(?:is\s+)?\**\s*(pass(?:ed)?|partial|fail(?:ed)?)\b/i.exec(text);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  return v.startsWith("pass") ? "pass" : v.startsWith("fail") ? "fail" : "partial";
}

export function deriveGateEvidence(input: { runs: AgentRun[]; events: FactoryEvent[]; clarifications: Clarification[]; artifacts?: Artifact[]; verified?: boolean }): GateEvidence {
  const items: EvidenceItem[] = [];
  const restart = input.verified && input.events.filter((event) => event.spec.reason === "Restarted").at(-1)?.metadata.creationTimestamp;
  const events = restart ? input.events.filter((event) => !event.metadata.creationTimestamp || event.metadata.creationTimestamp >= restart) : input.events;
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
    if (r.spec.replayOf || r.status?.phase !== "Succeeded" || r.metadata.labels?.[LABEL_SUPERSEDED]) continue;
    const key = `${r.spec.stage}/${r.spec.step}`;
    const prev = latest.get(key);
    if (!prev || roundOf(r) >= roundOf(prev)) latest.set(key, r);
  }
  for (const r of latest.values()) {
    let outcome = r.spec.outcomes?.length ? r.status?.result?.outcome : undefined;
    let parsed = false;
    if (!outcome) {
      // Fallback: a verdict stated only in text (older runs, or an agent that ignored the outcome field) must still count.
      // Only report artifacts, and only their beginning (the verdict comes first): research notes may *quote* code
      // that contains "Verdict: FAIL" and must not count.
      const reports = (input.artifacts ?? []).filter(
        (a) => a.spec.producedBy?.agentRunRef.name === r.metadata.name && VERDICT_ARTIFACTS.has(a.spec.artifactTypeRef.name),
      );
      const texts = [r.status?.result?.summary, ...reports.map((a) => a.spec.content.slice(0, 600))];
      outcome = texts.map(parseVerdict).find(Boolean);
      parsed = !!outcome;
    }
    if (!outcome) continue;
    const produced = r.spec.outputs?.some((o) => o.name === "source-code");
    const at = produced ? undefined : r.status?.finishedAt;
    const severity = downgrade(OUTCOME_SEVERITY[outcome] ?? "ok", at);
    items.push({
      severity,
      label: `${r.spec.agentRef.name} · ${r.spec.step}: ${outcome}${parsed ? " (from report text)" : ""}${OUTCOME_SEVERITY[outcome] ? staleNote(at) : ""}`,
      detail: r.status?.result?.summary ?? "",
      stage: r.spec.stage,
      runName: r.metadata.name,
    });
  }

  // Checks: the latest event per check name decides (a later pass clears an earlier failure).
  const checks = new Map<string, FactoryEvent>();
  for (const e of events) {
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

  if (events.some((e) => e.spec.reason === "LoopExhausted")) {
    items.push({ severity: "warning", label: "AI review loop exhausted", detail: "Blocking AI review findings may remain unresolved." });
  }
  const open = input.clarifications.filter((c) => !c.spec.answers?.length);
  if (open.length) items.push({ severity: "warning", label: `${open.length} open clarification(s)`, detail: open.flatMap((c) => c.spec.questions).join(" · ") });

  items.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const status = items.reduce<EvidenceSeverity>((s, i) => (RANK[i.severity] > RANK[s] ? i.severity : s), "ok");
  return { status, items };
}
