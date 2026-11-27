import { createHash } from "node:crypto";
import type { ChangeManifest, ChangedFile, ChangeSegment, ChangeStatus, FileCoverage, ReviewCoverage, SkipReason } from "../ports/index.ts";
import { SKIP_REASONS } from "../ports/index.ts";

/** Keeps every segment readable in one tool result (MAX_RESULT is 12k chars). */
export const SEGMENT_MAX = 8_000;

export interface ParsedFile {
  file: ChangedFile;
  /** `diff --git` … `+++` lines. */
  header: string;
  /** Segment text by `index - 1`, each starting with its `@@` line. */
  segments: string[];
}

export interface ParsedChange {
  manifest: ChangeManifest;
  files: ParsedFile[];
}

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock",
  "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "uv.lock"]);
const GENERATED = [/(^|\/)zz_generated[^/]*$/, /\.pb\.go$/, /_pb2(_grpc)?\.pyi?$/, /\.min\.(js|css)$/, /\.generated\.[^/]+$/,
  /(^|\/)__generated__\//, /\.snap$/];
const VENDORED = /(^|\/)(vendor|node_modules|third_party)\//;

/** Deterministic default review scope (ADR-0095 §7) for files no review-scope check classified. */
export function defaultScope(path: string, status: ChangeStatus): string | undefined {
  if (status === "binary") return "binary";
  if (LOCKFILES.has(path.split("/").at(-1)!)) return "lockfile";
  if (VENDORED.test(path)) return "vendored";
  if (GENERATED.some((re) => re.test(path))) return "generated";
  return undefined;
}

/** Go's convention (https://go.dev/s/generatedcode), also used by protobuf, mockgen, gqlgen, ent and others; plus `@generated`. */
const GENERATED_HEADER = /^\s*(?:\/\/|#|--|\/\*+|\*)\s*(?:Code generated\b.*\bDO NOT EDIT\b|@generated\b)/m;
const HEADER_LINES = 40;

export const hasGeneratedHeader = (text: string) => GENERATED_HEADER.test(text.split("\n", HEADER_LINES).join("\n"));

/**
 * ADR-0095 §7: marks generated files out of scope. Repository-declared paths are trusted (reviewed definitions); a
 * header is the change author's claim, so a modified file whose header this change *adds* stays in scope.
 * `head(file)` returns the head version's text, or undefined when unreadable (deleted files use the patch).
 */
export async function classifyGenerated(parsed: ParsedFile[], generatedPaths: (repository: string) => string[],
  head: (file: ChangedFile) => Promise<string | undefined>, matches: (path: string, glob: string) => boolean): Promise<void> {
  for (const p of parsed) {
    const f = p.file;
    if (!f.inScope) continue;
    if (generatedPaths(f.repository).some((g) => matches(f.path, g))) { exclude(f, "generated (repository)"); continue; }
    const removed = p.segments.join("\n").split("\n").filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    const text = f.status === "deleted" ? removed.join("\n") : await head(f);
    if (!text || !hasGeneratedHeader(text)) continue;
    const added = p.segments.join("\n").split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    if (f.status === "modified" && hasGeneratedHeaderLine(added) && !hasGeneratedHeaderLine(removed)) {
      f.scopeNote = "its generated header was added by this change, so it is reviewed";
      continue;
    }
    exclude(f, "generated (header)");
  }
}

const hasGeneratedHeaderLine = (lines: string[]) => lines.some((l) => GENERATED_HEADER.test(l));
const exclude = (f: ChangedFile, reason: string) => { f.inScope = false; f.scopeReason = reason; };

/** The top-level directory; a repository module graph would be more precise (ADR-0044, pending). */
const moduleOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "(root)");
const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
const stripPrefix = (p: string) => unquote(p.trim()).replace(/^[ab]\//, "");

/** Splits a hunk into segments of at most SEGMENT_MAX chars, tracking the line numbers of each part. */
function splitHunk(lines: string[], oldStart: number, newStart: number): { text: string; seg: Omit<ChangeSegment, "index"> }[] {
  const out: { text: string; seg: Omit<ChangeSegment, "index"> }[] = [];
  let o = oldStart, n = newStart;
  let buf: string[] = [], size = 0, so = o, sn = n, ol = 0, nl = 0;
  const flush = (whole: boolean) => {
    if (!buf.length) return;
    const head = `@@ -${so},${ol} +${sn},${nl} @@${whole ? "" : " (part of a larger hunk)"}`;
    const text = [head, ...buf].join("\n");
    out.push({ text, seg: { oldStart: so, oldLines: ol, newStart: sn, newLines: nl, bytes: Buffer.byteLength(text) } });
    buf = []; size = 0; so = o; sn = n; ol = 0; nl = 0;
  };
  const total = lines.reduce((s, l) => s + l.length + 1, 0);
  const whole = total <= SEGMENT_MAX - 100;
  for (const line of lines) {
    if (size + line.length + 1 > SEGMENT_MAX - 100 && buf.length) flush(false);
    buf.push(line.length > SEGMENT_MAX - 200 ? `${line.slice(0, SEGMENT_MAX - 200)} …(line clipped)` : line);
    size += Math.min(line.length, SEGMENT_MAX - 200) + 1;
    if (line.startsWith("+")) { n++; nl++; }
    else if (line.startsWith("-")) { o++; ol++; }
    else if (!line.startsWith("\\")) { o++; n++; ol++; nl++; }
  }
  flush(whole);
  return out;
}

/** Parses `git diff` output of one repository into files and readable segments. */
export function parseChange(repository: string, patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  for (const block of blocks) {
    const lines = block.replace(/\n$/, "").split("\n");
    const first = lines.findIndex((l) => l.startsWith("@@"));
    const headerLines = first < 0 ? lines : lines.slice(0, first);
    const get = (prefix: string) => headerLines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const plus = get("+++ "), minus = get("--- ");
    const renameTo = get("rename to "), renameFrom = get("rename from ");
    const gitLine = headerLines[0].slice("diff --git ".length);
    const fallback = stripPrefix(gitLine.slice(gitLine.lastIndexOf(" b/") + 1));
    const path = renameTo ? unquote(renameTo) : plus && plus.trim() !== "/dev/null" ? stripPrefix(plus) :
      minus && minus.trim() !== "/dev/null" ? stripPrefix(minus) : fallback;
    const binary = headerLines.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch");
    const status: ChangeStatus = binary ? "binary" : headerLines.some((l) => l.startsWith("new file mode")) ? "added" :
      headerLines.some((l) => l.startsWith("deleted file mode")) ? "deleted" : renameTo ? "renamed" : "modified";
    const segments: string[] = [];
    const meta: ChangeSegment[] = [];
    let additions = 0, deletions = 0;
    if (first >= 0) {
      let i = first;
      while (i < lines.length) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]);
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith("@@")) j++;
        const body = lines.slice(i + 1, j);
        additions += body.filter((l) => l.startsWith("+")).length;
        deletions += body.filter((l) => l.startsWith("-")).length;
        const context = lines[i].replace(/^@@[^@]*@@/, "").trim();
        for (const part of splitHunk(body, Number(m?.[1] ?? 0), Number(m?.[2] ?? 0))) {
          meta.push({ index: meta.length + 1, ...part.seg });
          segments.push(context ? part.text.replace(/^(@@[^@]*@@)/, `$1 ${context}`) : part.text);
        }
        i = j;
      }
    }
    const scopeReason = defaultScope(path, status);
    files.push({
      file: {
        repository, path, ...(renameFrom && unquote(renameFrom) !== path ? { previousPath: unquote(renameFrom) } : {}), status,
        additions, deletions, bytes: Buffer.byteLength(block), module: moduleOf(path), inScope: !scopeReason,
        ...(scopeReason ? { scopeReason } : {}), segments: meta,
      },
      header: headerLines.join("\n"),
      segments,
    });
  }
  return files;
}

export function buildChange(repos: { name: string; head: string; base: string; patch: string }[]): ParsedChange {
  const files = repos.flatMap((r) => parseChange(r.name, r.patch));
  const hash = createHash("sha256");
  for (const r of repos) hash.update(`${r.name}\0${r.head}\0${r.base}\0`).update(r.patch);
  const version = `${repos.map((r) => `${r.name}@${r.head.slice(0, 12)}..${r.base.slice(0, 12)}`).join(",")}#${hash.digest("hex").slice(0, 16)}`;
  return { manifest: { version, repositories: repos.map(({ name, head, base }) => ({ name, head, base })), files: files.map((f) => f.file) }, files };
}

const fileKey = (repository: string, path: string) => `${repository}\0${path}`;
const label = (m: ChangeManifest, f: { repository: string; path: string }) => (m.repositories.length > 1 ? `${f.repository}:${f.path}` : f.path);

/** The manifest as prompt content: metadata only, never patch text. */
export function renderManifest(m: ChangeManifest, enforced: boolean): string {
  const inScope = m.files.filter((f) => f.inScope);
  const out = m.files.filter((f) => !f.inScope);
  const sum = (fs: ChangedFile[], k: "additions" | "deletions") => fs.reduce((s, f) => s + f[k], 0);
  const row = (f: ChangedFile) => `| ${label(m, f)}${f.previousPath ? ` (from ${f.previousPath})` : ""}${f.scopeNote ? ` — ${f.scopeNote}` : ""} | ${f.status} | +${f.additions} −${f.deletions} | ${f.segments.length} |`;
  const modules = [...new Set(inScope.map((f) => `${m.repositories.length > 1 ? `${f.repository}:` : ""}${f.module}`))];
  const reasons = Object.entries(countBy(out.map((f) => f.scopeReason ?? "out of scope")));
  return [
    `${m.files.length} changed files (+${sum(m.files, "additions")} −${sum(m.files, "deletions")}); ${inScope.length} in review scope (+${sum(inScope, "additions")} −${sum(inScope, "deletions")}), ${out.length} out of scope${reasons.length ? ` (${reasons.map(([r, n]) => `${n} ${r}`).join(", ")})` : ""}. Manifest version \`${m.version}\`.`,
    "",
    ...(enforced ? [
      "The patch is **not** in this prompt. Work module by module:",
      "1. Read the module's files with `read_change` — pass several paths at once (`{ \"paths\": [...] }`); it returns as many as fit and tells you where to continue. Use `read_file` / `search_code` for surrounding code.",
      "2. Acknowledge them together with `acknowledge_change` (`{ \"files\": [{ \"path\": …, \"outcome\": \"reviewed\" }, …] }`); `skipped` needs a `reason` (" + SKIP_REASONS.join(", ") + ").",
      "`finish` is rejected while an in-scope file is unacknowledged, when a finding names a changed file you did not review, or when you accept the change with in-scope files skipped. Every tool result tells you the model steps left. `budget-exhausted` is accepted only in the last 3 steps; until then, keep reading. If it is truly short, acknowledge the rest as `budget-exhausted` and do not choose `accepted`.",
    ] : ["The patch is **not** in this prompt. Read the change of files with `read_change` (`{ \"paths\": [...] }`); use `read_file` / `search_code` for surrounding code."]),
    "",
    "### In review scope",
    ...modules.flatMap((mod) => {
      const fs = inScope.filter((f) => `${m.repositories.length > 1 ? `${f.repository}:` : ""}${f.module}` === mod);
      return ["", `#### ${mod} (${fs.length} files, +${sum(fs, "additions")} −${sum(fs, "deletions")})`, "| file | status | lines | segments |", "|---|---|---|---|", ...fs.map(row)];
    }),
    ...(out.length ? ["", "### Out of review scope (no acknowledgement needed; you may still read them)", "| file | reason |", "|---|---|",
      ...out.map((f) => `| ${label(m, f)} | ${f.scopeReason} |`)] : []),
  ].join("\n");
}

const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

/** A transcript note's `meta.review`. */
export type LedgerEntry =
  /** `step`: the last model step recorded before the read; the model has seen the result once a later step exists. */
  | { type: "read"; manifest: string; repository: string; path: string; segments: number[]; step?: number }
  | { type: "ack"; manifest: string; repository: string; path: string; outcome: "reviewed" | "skipped"; reason?: SkipReason; note?: string };

export interface Ledger {
  read: Map<string, Set<number>>;
  acks: Map<string, Extract<LedgerEntry, { type: "ack" }>>;
}

/**
 * `lastStep`: the latest model step in the transcript. A read counts only when a later model step exists, i.e. its
 * result reached the model, not just a Code Mode program or a call in the same batch as the acknowledgement.
 */
export function ledgerOf(entries: LedgerEntry[], manifest: string, lastStep?: number): Ledger {
  const read = new Map<string, Set<number>>();
  const acks = new Map<string, Extract<LedgerEntry, { type: "ack" }>>();
  for (const e of entries) {
    if (e.manifest !== manifest) continue;
    const k = fileKey(e.repository, e.path);
    if (e.type === "read") {
      if (e.step !== undefined && lastStep !== undefined && e.step >= lastStep) continue;
      const s = read.get(k) ?? new Set<number>();
      for (const i of e.segments) s.add(i);
      read.set(k, s);
    } else acks.set(k, e);
  }
  return { read, acks };
}

/** Segments of a file the run has not read yet; empty when fully read. A file must be read at least once. */
export function unreadSegments(ledger: Ledger, f: ChangedFile): number[] | "never-read" {
  const read = ledger.read.get(fileKey(f.repository, f.path));
  if (!read) return "never-read";
  return f.segments.map((s) => s.index).filter((i) => !read.has(i));
}

export function coverageOf(m: ChangeManifest, ledger: Ledger): ReviewCoverage {
  const files: FileCoverage[] = m.files.filter((f) => f.inScope).map((f) => {
    const ack = ledger.acks.get(fileKey(f.repository, f.path));
    return ack ? { repository: f.repository, path: f.path, state: ack.outcome, ...(ack.reason ? { reason: ack.reason } : {}), ...(ack.note ? { note: ack.note } : {}) }
      : { repository: f.repository, path: f.path, state: "unacknowledged" };
  });
  const outOfScopeReasons = countBy(m.files.filter((f) => !f.inScope).map((f) => f.scopeReason ?? "out of scope"));
  const generated = m.files.filter((f) => !f.inScope && f.scopeReason?.startsWith("generated")).map((f) => label(m, f));
  const partial = { manifest: m.version, files, outOfScope: m.files.length - files.length, outOfScopeReasons, generated };
  return { ...partial, summary: coverageSummary(partial) };
}

/** Finds the manifest file a path (optionally `repo:path`) refers to. */
export function findFile(m: ChangeManifest, path: string, repository?: string): ChangedFile | ChangedFile[] | undefined {
  let repo = repository;
  let p = path.trim().replace(/^\.\//, "");
  if (!repo) {
    const colon = p.indexOf(":");
    if (colon > 0 && m.repositories.some((r) => r.name === p.slice(0, colon))) { repo = p.slice(0, colon); p = p.slice(colon + 1); }
  }
  const hits = m.files.filter((f) => f.path === p && (!repo || f.repository === repo));
  return hits.length === 1 ? hits[0] : hits.length ? hits : undefined;
}

/**
 * ADR-0095 §7 finish rules: every in-scope file acknowledged, findings only on reviewed files, no `accepted` verdict
 * with files skipped for budget. Returns problems for the agent, empty when the coverage holds.
 */
export function coverageProblems(m: ChangeManifest, coverage: ReviewCoverage, report: { verdict?: string; findingPaths: string[] }): string[] {
  const problems: string[] = [];
  const shown = (f: { repository: string; path: string }) => label(m, f);
  const missing = coverage.files.filter((f) => f.state === "unacknowledged");
  if (missing.length) {
    problems.push(`${missing.length} in-scope file(s) are not acknowledged. Read each with read_change, then acknowledge_change (reviewed, or skipped with a reason): ${
      missing.slice(0, 40).map(shown).join(", ")}${missing.length > 40 ? `, … ${missing.length - 40} more` : ""}`);
  }
  const reviewed = new Set(coverage.files.filter((f) => f.state === "reviewed").map((f) => fileKey(f.repository, f.path)));
  const unreviewedFindings = [...new Set(report.findingPaths)].filter((p) => {
    const f = findFile(m, p);
    if (!f || Array.isArray(f)) return false; // not a changed file: a finding about untouched code is allowed
    return !reviewed.has(fileKey(f.repository, f.path));
  });
  if (unreviewedFindings.length) {
    problems.push(`Findings name changed files you did not review: ${unreviewedFindings.join(", ")}. Read their change and acknowledge them as reviewed, or remove those findings.`);
  }
  // A skip is a claim, not evidence: only a rename is accepted unread, and only when the manifest shows a rename.
  const unread = coverage.files.filter((f) => f.state === "skipped" &&
    !(f.reason === "mechanical-rename" && (findFile(m, f.path, f.repository) as ChangedFile | undefined)?.status === "renamed"));
  if (report.verdict === "accepted" && unread.length) {
    problems.push(`The verdict is "accepted" but ${unread.length} in-scope file(s) were skipped (${unread.slice(0, 10).map((f) => `${shown(f)}: ${f.reason}`).join(", ")}): you cannot accept code you have not read. Review them, or choose partially-accepted/rejected and say what is unreviewed.`);
  }
  return problems;
}

/** One line for the gate and the published review. */
export function coverageSummary(c: Omit<ReviewCoverage, "summary">): string {
  const reviewed = c.files.filter((f) => f.state === "reviewed").length;
  const skipped = c.files.filter((f) => f.state === "skipped").length;
  const missing = c.files.filter((f) => f.state === "unacknowledged").length;
  const reasons = Object.entries(c.outOfScopeReasons).map(([r, n]) => `${n} ${r}`).join(", ");
  return `${reviewed} of ${c.files.length} in-scope files reviewed` +
    `${skipped ? `, ${skipped} skipped` : ""}${missing ? `, ${missing} not acknowledged` : ""}${c.outOfScope ? `; ${c.outOfScope} out of scope (${reasons})` : ""}`;
}

export const isComplete = (c: ReviewCoverage) => c.files.every((f) => f.state === "reviewed");
