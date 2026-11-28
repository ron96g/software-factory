/** ADR-0083 X63c / ADR-0095 §7: the typed `code-review-report` of a factory candidate. */
export const CODE_REVIEW_REPORT = "code-review-report";

export interface CodeReviewFinding { severity: "blocking" | "non-blocking"; path: string; line?: number; message: string; fix?: string }
export interface CodeReviewReport { verdict: "approve" | "changes-requested"; summary: string; findings: CodeReviewFinding[] }

/** The report, or null for content written under the earlier Markdown format (or not a report at all). */
export function parseCodeReviewReport(content: string): CodeReviewReport | null {
  try {
    const v = JSON.parse(content) as Partial<CodeReviewReport>;
    if ((v?.verdict !== "approve" && v?.verdict !== "changes-requested") || typeof v.summary !== "string" || !Array.isArray(v.findings)) return null;
    if (!v.findings.every((f) => f && typeof f.path === "string" && typeof f.message === "string" && (f.severity === "blocking" || f.severity === "non-blocking"))) return null;
    return v as CodeReviewReport;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

/** The verdict and finding paths the coverage rules check. */
export const codeReviewReportReader = (content: string) => {
  const r = parseCodeReviewReport(content);
  return r ? { verdict: r.verdict, findingPaths: r.findings.map((f) => f.path) } : undefined;
};

const where = (f: CodeReviewFinding) => `\`${f.path}${f.line ? `:${f.line}` : ""}\``;

/** Readable Markdown for the item page and the developer; null when the content is not a typed report. */
export function renderCodeReviewReport(content: string): string | null {
  const r = parseCodeReviewReport(content);
  if (!r) return null;
  const blocking = r.findings.filter((f) => f.severity === "blocking");
  const other = r.findings.filter((f) => f.severity !== "blocking");
  return [
    `## Verdict: ${r.verdict === "approve" ? "Approve" : "Changes requested"}`,
    "",
    r.summary,
    ...(blocking.length ? ["", "### Blocking findings", ...blocking.map((f) => `- ${where(f)} ${f.message}${f.fix ? `\n  - **Fix:** ${f.fix}` : ""}`)] : []),
    ...(other.length ? ["", "### Non-blocking findings", ...other.map((f) => `- ${where(f)} ${f.message}`)] : []),
  ].join("\n");
}

/** The simulated executor's placeholder (ADR-0010): valid against the schema, approving, with no findings. */
export const simulatedCodeReviewReport = () => JSON.stringify({ verdict: "approve",
  summary: "Simulated review: no model was available, so the candidate was not actually reviewed.", findings: [] } satisfies CodeReviewReport);
