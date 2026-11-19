import type { FollowUpPreview } from "../ports/index.ts";

/** ADR-0068: ticket body from the already redacted and bounded evidence snapshot; no new evidence is read. */
export function renderFollowUpTicketBody(d: { instructions: string; snapshot: FollowUpPreview["snapshot"]; originUrl?: string; originName: string; factoryUrl?: string }): string {
  const link = d.factoryUrl ? `${d.factoryUrl.replace(/\/+$/, "")}/work-items/${encodeURIComponent(d.originName)}` : undefined;
  return [
    d.instructions.trim(),
    "## Origin",
    d.originUrl ? `Origin ticket: ${d.originUrl}` : undefined,
    `Factory work item: ${link ?? d.originName}`,
    "## Evidence",
    d.snapshot.content,
  ].filter((s) => s !== undefined && s !== "").join("\n\n");
}
