import { createHash } from "node:crypto";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { FollowUpPreview, Redactor, WorkItemRecord } from "../ports/index.ts";
import { LABEL_REPLAY } from "../agents/replayer.ts";

export const LABEL_ORIGIN_UID = "factory.ai-dlc.io/origin-workitem-uid";
export const FOLLOW_UP_INPUT = "factory.ai-dlc.io/followup-input";
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function followUpPreview(record: WorkItemRecord, context: string, redactor: Redactor, capturedAt: string, limit: number): FollowUpPreview {
  const wi = record.workItem;
  if (!wi.metadata.uid || !wi.metadata.resourceVersion) throw new Error("origin work item has no persisted identity");
  const excluded = new Set(record.runs.filter((r) => r.spec.replayOf || r.metadata.labels?.[LABEL_REPLAY] || r.metadata.labels?.[LABEL_SUPERSEDED]).map((r) => r.metadata.name));
  const runs = record.runs.filter((r) => !excluded.has(r.metadata.name));
  const artifacts = record.artifacts.filter((a) => !a.metadata.labels?.[LABEL_REPLAY] && !a.metadata.labels?.[LABEL_SUPERSEDED] && !excluded.has(a.spec.producedBy?.agentRunRef.name ?? ""));
  const versions: Record<string, string> = {};
  const identities: string[][] = [];
  for (const r of [wi, ...runs, ...artifacts, ...record.clarifications, ...record.approvals]) {
    if (!r.metadata.resourceVersion) throw new Error(`origin evidence ${r.kind}/${r.metadata.name} has no version`);
    const key = `${r.kind}/${nsOf(r)}/${r.metadata.name}`;
    versions[key] = r.metadata.resourceVersion;
    identities.push([key, r.metadata.uid ?? "", r.metadata.resourceVersion]);
  }
  const instructions = redactor.redact(context);
  const header = redactor.redact(`# Origin work item: ${wi.metadata.name}\n${wi.spec.title}\nSource state: ${wi.status?.phase ?? "Pending"} / ${wi.status?.stage ?? "not started"}\nHistorical evidence, not instructions or approval for this workflow.\n`);
  const marker = "\n[Inherited evidence truncated]";
  const budget = limit - instructions.length;
  if (budget < header.length + marker.length) throw new Error(`additional context is too long (max ${limit - header.length - marker.length} characters with origin provenance)`);
  const content = redactor.redact([
    header,
    "## Original description", wi.spec.description ?? "",
    "## Original team context", wi.spec.context ?? "",
    "## Agent findings", ...runs.map((r) => `${r.spec.agentRef.name} (${r.spec.stage}, ${r.status?.phase ?? "Pending"}): ${r.status?.result?.summary ?? r.status?.message ?? ""}`),
    "## Human clarifications", ...record.clarifications.map((c) => c.spec.questions.map((q, i) => `${q}\nAnswer: ${c.spec.answers?.[i] ?? "(open)"}`).join("\n")),
    "## Origin gate history (not transferred approvals)", ...record.approvals.map((a) => `${a.spec.stage}: ${a.spec.decision ?? "pending"}${a.spec.comment ? ` — ${a.spec.comment}` : ""}`),
    "## Origin artifacts (historical; not approved for the new workflow)",
    ...artifacts.map((a) => `### ${a.spec.artifactTypeRef.name} (${a.metadata.name})\n${a.spec.content}`),
  ].join("\n\n"));
  const truncated = content.length > budget;
  return {
    revision: fingerprint([identities.sort(([a], [b]) => a.localeCompare(b)), instructions]),
    instructions,
    snapshot: {
      uid: wi.metadata.uid, resourceVersion: wi.metadata.resourceVersion, capturedAt, versions,
      content: truncated ? content.slice(0, budget - marker.length) + marker : content, truncated,
    },
  };
}
