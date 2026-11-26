import type { ReviewVerdict } from "../model/kinds.ts";
import { REVIEW_VERDICTS } from "../model/kinds.ts";

/** ADR-0094: the `pr-review-report` contract and its rendering; pure, shared by the publisher and the UI. */
export interface PrReviewFinding {
  severity: "blocking" | "non-blocking";
  path: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  message: string;
  suggestion?: string;
}

/** ADR-0094: one inline review comment, in GitHub's review `comments[]` shape. */
export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
  body: string;
}
export interface PrReviewReport {
  verdict: ReviewVerdict;
  summary: string;
  rationale: string;
  accepted: string[];
  requiredChanges: string[];
  findings: PrReviewFinding[];
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = { accepted: "Accepted", "partially-accepted": "Partially accepted", rejected: "Rejected" };

const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** The `pr-review-report` contract (artifacts/pr-review-report.yaml); the schema check rejects malformed output earlier. */
export function parsePrReviewReport(content: string): PrReviewReport | null {
  try {
    const v = JSON.parse(content) as Record<string, unknown>;
    const accepted = strings(v.accepted);
    const requiredChanges = strings(v.requiredChanges);
    if (!REVIEW_VERDICTS.includes(v.verdict as ReviewVerdict) || typeof v.summary !== "string" || typeof v.rationale !== "string" ||
        !accepted || !requiredChanges || !Array.isArray(v.findings)) return null;
    return { verdict: v.verdict as ReviewVerdict, summary: v.summary, rationale: v.rationale, accepted, requiredChanges, findings: v.findings as PrReviewFinding[] };
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

const LEGACY_LABEL: Record<string, string> = { approve: "Approve", comment: "Comment", "request-changes": "Request changes" };

/**
 * For display only: a report written under an earlier contract (schema v1: verdict approve / comment / request-changes,
 * no rationale or accepted / required lists) still renders as Markdown. Never used to publish.
 */
export function renderReportForDisplay(content: string): string | null {
  const current = parsePrReviewReport(content);
  if (current) return renderReviewBody(current, current.verdict);
  try {
    const v = JSON.parse(content) as Record<string, unknown>;
    const label = typeof v.verdict === "string" ? LEGACY_LABEL[v.verdict] : undefined;
    if (!label || typeof v.summary !== "string" || !Array.isArray(v.findings)) return null;
    const report: PrReviewReport = { verdict: "accepted", summary: v.summary, rationale: typeof v.rationale === "string" ? v.rationale : "",
      accepted: strings(v.accepted) ?? [], requiredChanges: strings(v.requiredChanges) ?? [], findings: v.findings as PrReviewFinding[] };
    return renderReviewBody(report, report.verdict, undefined, new Set()).replace(/^## Verdict: .*/, `## Verdict: ${label}`).replace("**Why:** \n\n", "") +
      "\n\n_Written under an earlier report format: restart from analyze for an accepted / partially accepted / rejected verdict._";
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

const SEVERITY: Record<PrReviewFinding["severity"], string> = { blocking: "Blocking", "non-blocking": "Non-blocking" };
const lines = (f: PrReviewFinding) => (f.line === undefined ? "" : f.startLine && f.startLine !== f.line ? `:${f.startLine}-${f.line}` : `:${f.line}`);
const cite = (f: PrReviewFinding) => `\`${f.path}${lines(f)}\`${f.side === "LEFT" ? " (deleted line)" : ""}`;
const fence = (text: string, info: string) => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${info}\n${text.replace(/\n$/, "")}\n${ticks}`;
};

/** An inline comment's text: severity first, then the message and an applicable suggestion. */
export function renderComment(f: PrReviewFinding): string {
  return [`**${SEVERITY[f.severity]}:** ${f.message}`, f.suggestion !== undefined ? fence(f.suggestion, "suggestion") : ""].filter(Boolean).join("\n\n");
}

export function toComment(f: PrReviewFinding): ReviewComment {
  const side = f.side ?? "RIGHT";
  return { path: f.path, line: f.line!, side, ...(f.startLine && f.startLine !== f.line ? { start_line: f.startLine, start_side: side } : {}), body: renderComment(f) };
}

/**
 * The review body: verdict first, then why, what is accepted, what must change, and the findings that are not posted
 * as inline comments. `inline` lists the findings that are; absent, every finding is shown here with its placement
 * (the gate view, where each finding with a line is checked to be inline-able when the reviewer finishes).
 */
export function renderReviewBody(report: PrReviewReport, verdict: ReviewVerdict, overriddenBy?: string, inline?: Set<PrReviewFinding>): string {
  const list = (title: string, items: string[]) => (items.length ? [`### ${title}`, ...items.map((i) => `- ${i}`)].join("\n") : "");
  const preview = !inline;
  const where = (f: PrReviewFinding) => (preview ? (f.line !== undefined ? " _(inline comment)_" : " _(in the review)_") : "");
  const item = (f: PrReviewFinding) => `${cite(f)}${where(f)} ${f.message}${preview && f.suggestion !== undefined ? `\n\n${fence(f.suggestion, "suggestion").replace(/^/gm, "  ")}` : ""}`;
  const shown = report.findings.filter((f) => !inline?.has(f));
  const group = (sev: PrReviewFinding["severity"], title: string) => list(title, shown.filter((f) => f.severity === sev).map(item));
  const inlineCount = inline?.size ?? 0;
  return [
    `## Verdict: ${VERDICT_LABEL[verdict]}`,
    overriddenBy ? `_Set by ${overriddenBy}; the agent proposed ${VERDICT_LABEL[report.verdict]}._` : "",
    report.summary.trim(),
    report.rationale.trim() ? `**Why:** ${report.rationale.trim()}` : "",
    list("Accepted", report.accepted),
    list(verdict === "rejected" ? "What a new attempt must do differently" : "Required changes", report.requiredChanges),
    group("blocking", inlineCount ? "Other blocking findings" : "Blocking findings"),
    group("non-blocking", inlineCount ? "Other non-blocking findings" : "Non-blocking findings"),
    inlineCount ? `_${inlineCount} finding${inlineCount === 1 ? " is" : "s are"} commented inline._` : "",
    "_Reviewed by the software factory and approved by a human._",
  ].filter(Boolean).join("\n\n");
}
