/**
 * ADR-0063: a `verification-report` is stored as structured JSON (machine-readable, validated against its ArtifactType).
 * Humans meet it at the gate and in the PR body, so this renders it as Markdown there. It never invents data: an
 * unrecognised or empty field is shown as `–` or omitted, and unparseable content stays raw.
 */

type VerificationReport = {
  verdict?: unknown;
  summary?: unknown;
  reasons?: unknown;
  traceMatrix?: unknown;
  checks?: unknown;
  missingEvidence?: unknown;
  notes?: unknown;
};

const VERDICT_LABEL: Record<string, string> = { pass: "✅ pass", fail: "❌ fail", partial: "⚠️ partial", inspected: "🔍 inspected" };
const verdictLabel = (v: unknown) => (typeof v === "string" ? (VERDICT_LABEL[v] ?? v) : "–");
// Table cells must not contain raw pipes or newlines; empty values are shown, never fabricated.
const cell = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() : "–");
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
const rowList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);

/** The verification report as readable Markdown, or null when the content is not a report (so callers fall back to raw). */
export function renderVerificationReport(content: string): string | null {
  let v: VerificationReport;
  try {
    v = JSON.parse(content) as VerificationReport;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.verdict !== "string" && typeof v.summary !== "string" && !Array.isArray(v.traceMatrix)) return null;

  const lines: string[] = [];
  lines.push(`**Verdict: ${typeof v.verdict === "string" ? v.verdict : "reported"}**`);
  if (typeof v.summary === "string" && v.summary.trim()) lines.push("", v.summary.trim());

  const reasons = stringList(v.reasons);
  if (reasons.length) lines.push("", "### Why", ...reasons.map((r) => `- ${r}`));

  const matrix = rowList(v.traceMatrix);
  if (matrix.length) {
    lines.push("", "### Acceptance criteria", "", "| Criterion | Result | Requirement |", "|---|---|---|");
    for (const t of matrix) lines.push(`| ${cell(t.criterion)} | ${verdictLabel(t.result)} | ${cell(t.requirement)} |`);
    lines.push("", "**Evidence per criterion**");
    for (const t of matrix) {
      const covered = typeof t.coveredBy === "string" && t.coveredBy.trim() ? ` _(covered by ${cell(t.coveredBy)})_` : "";
      lines.push(`- **${cell(t.criterion)}** — ${cell(t.evidence)}${covered}`);
    }
  }

  if (v.checks && typeof v.checks === "object" && !Array.isArray(v.checks)) {
    const entries = Object.entries(v.checks as Record<string, unknown>);
    if (entries.length) {
      lines.push("", "### Checks", "", "| Check | Result |", "|---|---|");
      for (const [name, value] of entries) lines.push(`| ${cell(name)} | ${cell(value)} |`);
    }
  }

  const missing = stringList(v.missingEvidence);
  if (missing.length) lines.push("", "### Missing evidence", ...missing.map((m) => `- ${m}`));
  const notes = stringList(v.notes);
  if (notes.length) lines.push("", "### Notes", ...notes.map((n) => `- ${n}`));

  return lines.join("\n");
}
