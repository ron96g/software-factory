/**
 * ADR-0094: which lines of a unified diff GitHub accepts review comments on. `RIGHT` lines are added or context lines
 * of the head version, `LEFT` lines are deleted or context lines of the base version, both only inside a hunk.
 */
export interface DiffLines {
  right: Map<string, Set<number>>;
  left: Map<string, Set<number>>;
}

const add = (m: Map<string, Set<number>>, path: string, line: number) => {
  let s = m.get(path);
  if (!s) m.set(path, (s = new Set()));
  s.add(line);
};

/** Parses `git diff` output (default prefixes `a/`, `b/`). Deleted files have no `RIGHT` lines. */
export function parseDiffLines(patch: string): DiffLines {
  const out: DiffLines = { right: new Map(), left: new Map() };
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) { inHunk = false; oldPath = newPath = undefined; continue; }
    if (!inHunk && raw.startsWith("--- ")) { oldPath = raw === "--- /dev/null" ? undefined : raw.slice(4).replace(/^a\//, ""); continue; }
    if (!inHunk && raw.startsWith("+++ ")) { newPath = raw === "+++ /dev/null" ? undefined : raw.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (raw.startsWith("+")) { if (newPath) add(out.right, newPath, newLine); newLine++; }
    else if (raw.startsWith("-")) { if (oldPath) add(out.left, oldPath, oldLine); oldLine++; }
    else if (raw.startsWith(" ")) {
      if (newPath) add(out.right, newPath, newLine);
      if (oldPath) add(out.left, oldPath, oldLine);
      newLine++; oldLine++;
    } else if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    else inHunk = false;
  }
  return out;
}

export interface LineTarget {
  path: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
}

/** Why a finding can't be an inline comment, or undefined when GitHub will accept it. */
export function inlineProblem(diff: DiffLines, f: LineTarget): string | undefined {
  if (f.line === undefined) return "it has no line";
  const lines = (f.side === "LEFT" ? diff.left : diff.right).get(f.path);
  if (!lines) return `${f.path} has no ${f.side === "LEFT" ? "deleted or context" : "added or context"} lines in the diff`;
  const from = f.startLine ?? f.line;
  if (from > f.line) return "startLine is after line";
  for (let l = from; l <= f.line; l++) if (!lines.has(l)) return `${f.path}:${l} is outside the changed hunks`;
  return undefined;
}
