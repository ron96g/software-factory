/** ADR-0076: the reviewed body, then the origin links. Provenance is appended here, so neither an agent nor an edit can drop it. */
export function renderFollowUpTicketBody(d: { body: string; originUrl?: string; originName: string; factoryUrl?: string }): string {
  const link = d.factoryUrl ? `${d.factoryUrl.replace(/\/+$/, "")}/items/${encodeURIComponent(d.originName)}` : undefined;
  return [
    d.body.trim(),
    "## Origin",
    d.originUrl ? `Origin ticket: ${d.originUrl}` : undefined,
    `Factory work item: ${link ?? d.originName} (investigation and evidence)`,
  ].filter((s) => s !== undefined && s !== "").join("\n\n");
}

const MAX_BACKGROUND = 2_000;

/** ADR-0076 fallback when no agent drafts: short and editable, never the evidence snapshot. */
export function templateFollowUpTicketBody(d: { instructions: string; originTitle: string; originDescription?: string }): string {
  const description = d.originDescription?.trim() ?? "";
  const background = description.length > MAX_BACKGROUND ? `${description.slice(0, MAX_BACKGROUND).trimEnd()} …` : description;
  return [
    d.instructions.trim() ? `## Requirements\n\n${d.instructions.trim()}` : undefined,
    `## Background\n\n${background || d.originTitle.trim()}`,
  ].filter(Boolean).join("\n\n");
}
