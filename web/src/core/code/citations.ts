import type { FileReader } from "../ports/index.ts";

/** A code location: `repo:path:line`, `repo:path:start-end`, or the same without `repo:` (ADR-0057). */
export interface Citation {
  repository?: string;
  path: string;
  startLine: number;
  endLine: number;
}

// The path needs a file extension that starts with a letter, so hosts and ports (`127.0.0.1:3000`) don't match.
const PATTERN = String.raw`(?:([A-Za-z0-9][\w.-]{0,99}):)?((?:[\w.@+-]+\/)*[\w.@+-]*\.[A-Za-z]\w{0,9}):(\d{1,6})(?:-(\d{1,6}))?`;
const IN_TEXT = new RegExp(String.raw`(?<![\w./:-])${PATTERN}(?![\w-])`, "g");
const EXACT = new RegExp(`^${PATTERN}$`);

const citation = (m: RegExpExecArray): Citation | undefined => {
  const startLine = Number(m[3]);
  const endLine = m[4] ? Number(m[4]) : startLine;
  if (startLine < 1 || endLine < startLine) return undefined;
  return { repository: m[1] || undefined, path: m[2], startLine, endLine };
};

export const formatCitation = (c: Citation) =>
  `${c.repository ? `${c.repository}:` : ""}${c.path}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`;

/** Citations in order of first appearance, without duplicates. */
export function findCitations(text: string): Citation[] {
  const seen = new Map<string, Citation>();
  for (const m of text.matchAll(IN_TEXT)) {
    const c = citation(m as RegExpExecArray);
    if (c && !seen.has(formatCitation(c))) seen.set(formatCitation(c), c);
  }
  return [...seen.values()];
}

export function parseCitation(ref: string): Citation | undefined {
  const m = EXACT.exec(ref.trim());
  return m ? citation(m) : undefined;
}

/**
 * Reads a file of one of `repositories` (the run's Ready workspaces). With several workspaces the reader expects
 * `<repo>/<path>`; with one, the plain path. Path confinement is the reader's job (ADR-0022).
 */
export async function readCited(files: FileReader, repositories: string[], c: { repository?: string; path: string }): Promise<string[]> {
  const repository = c.repository ?? (repositories.length === 1 ? repositories[0] : undefined);
  if (!repository) throw new Error(`name the repository (one of ${repositories.join(", ")})`);
  if (!repositories.includes(repository)) throw new Error(`not one of this run's workspaces (${repositories.join(", ") || "none"})`);
  return fileLines(await files.readFile(repositories.length > 1 ? `${repository}/${c.path}` : c.path));
}

/** Lines of a file; a trailing newline does not count as an extra line. */
export const fileLines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

export const numbered = (lines: string[], first: number) =>
  lines.map((line, i) => `${String(first + i).padStart(5)}| ${line}`).join("\n");
