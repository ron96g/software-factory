import type { WorkItemRecord } from "../ports/agent-chat.ts";

const roundOf = (name: string) => /-r(\d+)(?:-replay-\d+)?$/.exec(name)?.[1] ?? "?";
const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)} …[truncated]` : s);

/** Bounded, chronological evidence shared by explanations and contextual investigation. */
export function workItemDigest({ workItem: wi, runs, artifacts, clarifications: clar, approvals: appr, events }: WorkItemRecord): string {
  const parts: string[] = [
    `# Work item ${wi.metadata.name}: ${wi.spec.title}`,
    clip(wi.spec.description, 2000),
    wi.spec.context ? `## Additional context from the team\n${clip(wi.spec.context, 4000)}` : "",
    wi.spec.originSnapshot ? `## Inherited work-item evidence (historical, captured ${wi.spec.originSnapshot.capturedAt})\n${wi.spec.originSnapshot.content}` : "",
    `Status: ${wi.status?.phase} · stage ${wi.status?.stage} · round ${wi.status?.round}`,
    "## Agent runs (chronological)",
    ...runs.map((r) => {
      const res = r.status?.result;
      const p = r.status?.provenance;
      return [
        `- **${r.spec.agentRef.name}** · ${r.spec.stage}/${r.spec.step} · round ${roundOf(r.metadata.name)}${r.spec.replayOf ? " · replay" : ""} · ${r.status?.phase} · ${p?.executor ?? ""}${p?.model ? ` (${p.model.name})` : ""} · run \`${r.metadata.name}\``,
        res?.summary ? `  - summary: ${clip(res.summary, 800)}` : "",
        res?.outcome ? `  - outcome: ${res.outcome}` : "",
        res?.questions?.length ? `  - asked: ${res.questions.join(" | ")}` : "",
        r.status?.message ? `  - message: ${clip(r.status.message, 400)}` : "",
      ].filter(Boolean).join("\n");
    }),
    "## Artifacts (latest content per run, truncated)",
    ...artifacts.map((a) => `### ${a.spec.artifactTypeRef.name} by ${a.spec.producedBy?.agentRef.name} (run \`${a.spec.producedBy?.agentRunRef.name}\`)\n${clip(a.spec.content, 6000)}`),
    "## Human input",
    ...clar.map((c) => `- clarification (${c.spec.stage}): ${c.spec.questions.join(" | ")} → ${c.spec.answers?.join(" | ") ?? "(open)"}`),
    ...appr.map((a) => `- approval (${a.spec.stage}): ${a.spec.decision ?? "pending"}${a.spec.comment ? ` — ${a.spec.comment}` : ""}`),
    "## Key events",
    ...events.filter((e) => e.spec.type === "Warning" || !["Started", "Succeeded", "Preparing"].includes(e.spec.reason))
      .slice(-40).map((e) => `- ${e.metadata.creationTimestamp} ${e.spec.type === "Warning" ? "⚠ " : ""}${e.spec.reason}: ${clip(e.spec.message, 300)}`),
  ];
  const text = parts.join("\n");
  const marker = "\n…[record truncated]";
  return text.length > 60_000 ? `${text.slice(0, 60_000 - marker.length)}${marker}` : text;
}
