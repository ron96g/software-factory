import type { Artifact } from "@/core/model/kinds.ts";

/** A `ticket-draft` as the ticket that will be published (ADR-0084); null for any other artifact. */
export function ticketDraftMarkdown(a: Artifact): string | null {
  if (a.spec.artifactTypeRef.name !== "ticket-draft") return null;
  try {
    const v = JSON.parse(a.spec.content) as { title?: unknown; body?: unknown };
    if (typeof v.title !== "string" || typeof v.body !== "string") return null;
    return `# ${v.title}\n\n${v.body}\n\n---\n\n_Published exactly as shown after approval; a link to this work item is added below._`;
  } catch {
    return null;
  }
}
