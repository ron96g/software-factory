import type { Artifact } from "@/core/model/kinds.ts";
import { renderVerificationReport } from "../core/artifacts/render.ts";

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

/** A `verification-report` as readable Markdown (ADR-0063); null for any other artifact or unparseable content. */
export function verificationReportMarkdown(a: Artifact): string | null {
  if (a.spec.artifactTypeRef.name !== "verification-report") return null;
  return renderVerificationReport(a.spec.content);
}

/** Any structured artifact the UI can show as readable Markdown instead of raw JSON (ADR-0084 ticket drafts, ADR-0063 verification reports). */
export function artifactMarkdown(a: Artifact): string | null {
  return ticketDraftMarkdown(a) ?? verificationReportMarkdown(a);
}
