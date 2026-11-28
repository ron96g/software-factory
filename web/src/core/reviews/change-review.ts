import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type { AgentRun, Artifact, Workspace } from "../model/kinds.ts";
import type {
  AgentResult, AgentToolOffering, CandidateDiffReader, ChangedFile, ChangeManifest, ChangeReviewSession, ChangeReviewSessions,
  ContextProvider, ContextSection, ExecutionContext, FinishValidator, InputView, ReviewCoverage, ReviewCoverageReader, TranscriptReader,
  TranscriptRef, WorkspaceReaderFactory,
} from "../ports/index.ts";
import { SKIP_REASONS, type SkipReason } from "../ports/index.ts";
import { MAX_RESULT, formatMarker } from "../agents/truncation.ts";
import { WRAP_UP_WARNING } from "../agents/run-harness.ts";
import {
  buildChange, classifyGenerated, coverageOf, coverageProblems, findFile, ledgerOf, renderManifest, unreadSegments,
  type LedgerEntry, type ParsedChange, type ParsedFile,
} from "./change-manifest.ts";

export const CHANGE_TOOLS = ["read_change", "acknowledge_change"] as const;
/** Large enough for any reviewable change; a larger diff is refused rather than silently cut (ADR-0095 §7). */
const DIFF_BYTES = 32 * 1024 * 1024;
const SYSTEM = { type: "system" as const, id: "change-review" };
const MAX_LEDGERS = 256;

/** How a review report type exposes its verdict and the files its findings name; registered in the composition root. */
export type ReviewReportReader = (content: string) => { verdict?: string; findingPaths: string[] } | undefined;

interface Note { seq: number; meta?: { changeManifest?: ChangeManifest; review?: LedgerEntry; step?: unknown } }
/** `step`: the latest model step marker (tool loop: `meta.step` on calls; OpenCode: step-ended notes). */
interface Ledger { seq: number; manifest?: ChangeManifest; entries: LedgerEntry[]; step?: number }

const seen = (l: Ledger, manifest: string) => ledgerOf(l.entries, manifest, l.step);
/** Only a git-pinned base can be diffed; without one the review keeps the inline diff. */
const ready = (w: Workspace) => w.status?.phase === "Ready" && !!w.status.path && /^[a-f0-9]{40,64}$/.test(w.status.baseCommit ?? "");

/**
 * ADR-0095 §7: the pull request's change as a manifest (inline), `read_change` / `acknowledge_change` (on demand,
 * recorded), and the coverage rules checked at `finish`. The ledger is the run's append-only transcript, read
 * incrementally and cached per transcript.
 */
export class ChangeReviewService implements ContextProvider, AgentToolOffering, ChangeReviewSessions, FinishValidator, ReviewCoverageReader, InputView {
  readonly name = "change-manifest";
  /** `diffs`: a pull request's committed head; `candidates`: a factory candidate's working tree. */
  private readonly d: { diffs: CandidateDiffReader; candidates: CandidateDiffReader; transcripts: TranscriptReader; readers: WorkspaceReaderFactory; reports: Record<string, ReviewReportReader> };
  private readonly changes = new Map<string, Promise<ParsedChange>>();
  private readonly ledgers = new Map<string, Promise<Ledger>>();
  constructor(d: ChangeReviewService["d"]) { this.d = d; }

  /** A run that produces a review report must read and acknowledge the change; other runs may read it. */
  private enforced(outputs: { name: string }[]) { return outputs.some((o) => !!this.d.reports[o.name]); }

  /**
   * A pull request item: every run on it (research and explanation may read, reviews must acknowledge). A factory
   * candidate: only runs that produce a review report; other steps keep the inline `source-code` diff for now.
   */
  private reviewed(ctx: ExecutionContext): Workspace[] {
    if (ctx.workItem.spec.pullRequest) return ctx.workspaces.filter((w) => w.spec.checkout && ready(w));
    return this.enforced(ctx.run.spec.outputs) ? ctx.workspaces.filter(ready) : [];
  }

  private applies(ctx: ExecutionContext) { return this.reviewed(ctx).length > 0; }

  appliesTo(ctx: ExecutionContext): boolean { return this.applies(ctx); }

  /** In a review run, the `source-code` input keeps only the developer's notes; the diff is read via the manifest. */
  view(ctx: ExecutionContext, input: Artifact): string | undefined {
    if (input.spec.artifactTypeRef.name !== "source-code" || !this.applies(ctx)) return undefined;
    // The diff is appended by finishResult under "## Diff"; without that heading nothing is stripped, and the notes
    // stay whole rather than being cut at a guess.
    const at = input.spec.content.lastIndexOf("\n## Diff\n");
    const notes = (at < 0 ? input.spec.content : input.spec.content.slice(0, at)).trim();
    return `${notes}\n\n_The diff is not inlined: the change manifest below lists every changed file; read them with \`read_change\`._`;
  }

  async provide(ctx: ExecutionContext): Promise<ContextSection[]> {
    const pr = ctx.workItem.spec.pullRequest;
    const change = await this.change(ctx);
    // Pins the manifest for this run, once: coverage is computed against exactly what the agent was shown.
    if ((await this.ledger(ctx.transcript.ref)).manifest?.version !== change.manifest.version) {
      await ctx.transcript.record({ role: "note", author: SYSTEM, content: `change manifest ${change.manifest.version}: ${change.manifest.files.length} files`,
        meta: { changeManifest: change.manifest } });
    }
    const repos = change.manifest.repositories;
    const range = repos.map((r) => `${r.name} ${r.base.slice(0, 12)}..${pr ? r.head.slice(0, 12) : "working tree"}`).join(", ");
    return [{
      title: pr ? `Pull request #${pr.number} (head ${pr.headSha.slice(0, 12)}, base ${pr.baseRef}) — change manifest` : "Candidate change — change manifest",
      content: [
        pr ? `Review exactly this change: ${range}. Line numbers of the head version are the \`+\` side of each segment header; only lines inside a segment can carry an inline comment.`
          : `Review exactly this candidate: ${range} (committed and uncommitted changes against the pinned base). Line numbers are the \`+\` side of each segment header.`,
        "",
        renderManifest(change.manifest, this.enforced(ctx.run.spec.outputs)),
      ].join("\n"),
      source: pr ? "pull-request" : "candidate",
      revision: change.manifest.version,
      counts: { changedFiles: change.manifest.files.length, inScopeFiles: change.manifest.files.filter((f) => f.inScope).length },
    }];
  }

  async tools(ctx: ExecutionContext): Promise<string[]> {
    return !this.applies(ctx) ? [] : this.enforced(ctx.run.spec.outputs) ? [...CHANGE_TOOLS] : ["read_change"];
  }

  session(ctx: ExecutionContext, budget?: { maxSteps: number }): ChangeReviewSession | undefined {
    if (!this.applies(ctx)) return undefined;
    /** Steps left after the current one; undefined when the budget or the step markers are unknown. */
    const remaining = async () => {
      const step = (await this.ledger(ctx.transcript.ref)).step;
      return budget && step !== undefined ? Math.max(0, budget.maxSteps - step) : undefined;
    };
    const stepsNote = async () => { const r = await remaining(); return r === undefined ? "" : `\n[${r} model step(s) left in your budget]`; };
    const resolve = (change: ParsedChange, path: string): ParsedFile => {
      const f = findFile(change.manifest, path);
      if (!f) throw new Error(`"${path}" is not a changed file of this change; use a path from the change manifest`);
      if (Array.isArray(f)) throw new Error(`"${path}" changed in several repositories (${f.map((x) => x.repository).join(", ")}); use repository:path`);
      return change.files.find((p) => p.file === f)!;
    };
    return {
      read: async ({ paths, from }) => {
        if (!paths.length) throw new Error("pass at least one path");
        if (from !== undefined && paths.length > 1) throw new Error("from continues a single file; pass one path with it");
        const change = await this.change(ctx);
        const files = [...new Set(paths)].map((p) => resolve(change, p));
        const out: string[] = [];
        let used = 0;
        const budget = MAX_RESULT - 400;
        let stopped: { file: ParsedFile; next: number; rest: ParsedFile[] } | undefined;
        for (const [k, parsed] of files.entries()) {
          const file = parsed.file;
          const n = parsed.segments.length;
          const start = k === 0 ? from ?? 1 : 1;
          if (!Number.isInteger(start) || start < 1 || (n && start > n)) throw new Error(`from must be between 1 and ${n}`);
          const head = `### ${file.repository}:${file.path} — ${file.status}${file.previousPath ? ` from ${file.previousPath}` : ""}, +${file.additions} −${file.deletions}, ${n} segment(s)`;
          const fixed = head.length + parsed.header.length + 40;
          if (out.length && used + fixed > budget) { stopped = { file: parsed, next: 1, rest: files.slice(k + 1) }; break; }
          const taken: number[] = [];
          let size = fixed;
          for (let i = start; i <= n; i++) {
            const text = parsed.segments[i - 1];
            if ((taken.length || out.length) && used + size + text.length + 1 > budget) break;
            taken.push(i);
            size += text.length + 1;
          }
          if (n && !taken.length) { stopped = { file: parsed, next: start, rest: files.slice(k + 1) }; break; }
          const step = (await this.ledger(ctx.transcript.ref)).step;
          await this.record(ctx, { type: "read", manifest: change.manifest.version, repository: file.repository, path: file.path, segments: taken, ...(step !== undefined ? { step } : {}) });
          used += size;
          if (!n) { out.push(`${head}\n(no textual diff${file.status === "binary" ? ": binary file" : ""})`); continue; }
          const last = taken.at(-1)!;
          out.push(`${head}; segments ${taken[0]}-${last} of ${n}\n\`\`\`diff\n${parsed.header}\n${taken.map((i) => parsed.segments[i - 1]).join("\n")}\n\`\`\``);
          if (last < n) { stopped = { file: parsed, next: last + 1, rest: files.slice(k + 1) }; break; }
        }
        if (!stopped) return out.join("\n\n") + await stepsNote();
        const pending = [stopped.file, ...stopped.rest].map((p) => p.file.path);
        const next = stopped.next > 1 ? `paths=["${stopped.file.file.path}"]_from=${stopped.next}` : `paths=${JSON.stringify(pending)}`;
        // The truncation marker must stay the last line.
        return `${out.join("\n\n")}${await stepsNote()}\n${formatMarker("read_change", `${pending.length}_file(s)`, next)}`;
      },
      acknowledge: async ({ files }) => {
        if (!files.length) throw new Error("pass at least one file");
        const change = await this.change(ctx);
        const lines: string[] = [];
        for (const { path, outcome, reason, note } of files) {
          try {
            const { file } = resolve(change, path);
            if (outcome !== "reviewed" && outcome !== "skipped") throw new Error(`outcome must be "reviewed" or "skipped"`);
            if (outcome === "skipped" && !SKIP_REASONS.includes(reason as SkipReason)) throw new Error(`a skipped file needs reason: ${SKIP_REASONS.join(", ")}`);
            if (outcome === "skipped" && reason === "budget-exhausted") {
              const left = await remaining();
              if (left !== undefined && left > WRAP_UP_WARNING) {
                throw new Error(`${left} model steps remain; budget-exhausted is accepted only in the last ${WRAP_UP_WARNING}. Read the file instead (several per read_change call)`);
              }
            }
            if (outcome === "reviewed") {
              const unread = unreadSegments(seen(await this.ledger(ctx.transcript.ref), change.manifest.version), file);
              if (unread === "never-read") throw new Error("not read yet (a read counts once its result has reached you: call read_change directly, then acknowledge in a later step)");
              if (unread.length) throw new Error(`segment(s) ${unread.join(", ")} not read; call read_change with from=${unread[0]}`);
            }
            await this.record(ctx, { type: "ack", manifest: change.manifest.version, repository: file.repository, path: file.path, outcome,
              ...(outcome === "skipped" ? { reason: reason as SkipReason } : {}), ...(note ? { note: String(note).slice(0, 500) } : {}) });
            lines.push(`- ${file.path}: ${outcome}${outcome === "skipped" ? ` (${reason})` : ""}`);
          } catch (e) {
            lines.push(`- ${path}: REFUSED — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const coverage = coverageOf(change.manifest, seen(await this.ledger(ctx.transcript.ref), change.manifest.version));
        const open = coverage.files.filter((f) => f.state === "unacknowledged");
        return [...lines, (await stepsNote()).trim(), open.length ? `${open.length} in-scope file(s) left, e.g. ${open.slice(0, 8).map((f) => f.path).join(", ")}` : "All in-scope files are acknowledged."].filter(Boolean).join("\n");
      },
    };
  }

  async validate(ctx: ExecutionContext, result: AgentResult): Promise<string[]> {
    const reports = (result.artifacts ?? []).filter((a) => this.d.reports[a.type]);
    if (!reports.length) return [];
    const state = await this.state(ctx.transcript.ref);
    if (!state) return this.applies(ctx) ? ["The change manifest of this review was not recorded; the review cannot be validated. Retry the run."] : [];
    return reports.flatMap((a) => {
      const report = this.d.reports[a.type](a.content);
      if (!report) return []; // the schema check reports the shape
      const mismatch = report.verdict && result.outcome && result.outcome !== report.verdict
        ? [`the outcome "${result.outcome}" must equal the report's verdict "${report.verdict}"`] : [];
      return [...mismatch, ...coverageProblems(state.manifest, state.coverage, report)].map((p) => `${a.type}: ${p}`);
    });
  }

  async coverage(run: AgentRun): Promise<ReviewCoverage | undefined> {
    const ref = run.status?.transcriptRef;
    if (!ref || !this.enforced(run.spec.outputs ?? [])) return undefined;
    return (await this.state(ref))?.coverage;
  }

  private async state(ref: TranscriptRef): Promise<{ manifest: ChangeManifest; coverage: ReviewCoverage } | undefined> {
    const { manifest, entries, step } = await this.ledger(ref);
    return manifest && { manifest, coverage: coverageOf(manifest, ledgerOf(entries, manifest.version, step)) };
  }

  /**
   * Transcripts are append-only, so a cached ledger only needs the messages after its last seq. Refreshes of one
   * transcript are serialized, and a message at or below the cached seq is never applied twice.
   */
  private ledger(ref: TranscriptRef): Promise<Ledger> {
    const key = `${ref.namespace}/${ref.id}`;
    const prev = this.ledgers.get(key) ?? Promise.resolve({ seq: 0, entries: [] } as Ledger);
    const next = prev.catch(() => ({ seq: 0, entries: [] } as Ledger)).then(async (ledger) => {
      for (;;) {
        const page = (await this.d.transcripts.read(ref, { afterSeq: ledger.seq, limit: 5_000 })) as Note[];
        for (const m of page) {
          if (m.seq <= ledger.seq) continue;
          if (m.meta?.changeManifest) ledger.manifest = m.meta.changeManifest;
          if (m.meta?.review) ledger.entries.push(m.meta.review);
          if (typeof m.meta?.step === "number" && m.meta.step > (ledger.step ?? 0)) ledger.step = m.meta.step;
          ledger.seq = m.seq;
        }
        if (page.length < 5_000) return ledger;
      }
    });
    this.ledgers.delete(key);
    this.ledgers.set(key, next);
    if (this.ledgers.size > MAX_LEDGERS) this.ledgers.delete(this.ledgers.keys().next().value!);
    return next;
  }

  private async record(ctx: ExecutionContext, entry: LedgerEntry) {
    const what = entry.type === "read" ? `read ${entry.path} segments [${entry.segments.join(",")}]`
      : `acknowledged ${entry.path}: ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`;
    await ctx.transcript.record({ role: "note", author: SYSTEM, content: what, meta: { review: entry } });
  }

  /** Deterministic for the pinned workspaces and repository definitions; cached by both. A candidate is keyed by its diff. */
  private change(ctx: ExecutionContext): Promise<ParsedChange> {
    const pr = ctx.workItem.spec.pullRequest;
    const ws = this.reviewed(ctx);
    const generated = (repo: string) => ctx.repositories.find((r) => r.metadata.name === repo)?.spec.review?.generatedPaths ?? [];
    // A working tree can change between runs, so a candidate's change is pinned per run (the reviewer cannot write).
    const key = !pr ? `run:${ctx.run.metadata.namespace}/${ctx.run.metadata.name}` : ws.map((w) => `${w.metadata.name}@${w.status?.baseCommit}:${pr.headSha}:${generated(w.spec.repositoryRef.name).join("|")}`).join(",");
    let hit = this.changes.get(key);
    if (!hit) {
      hit = this.build(ws, pr?.headSha, generated);
      hit.catch(() => this.changes.delete(key));
      this.changes.set(key, hit);
      if (this.changes.size > 8) this.changes.delete(this.changes.keys().next().value!);
    }
    return hit;
  }

  private async build(ws: Workspace[], head: string | undefined, generated: (repo: string) => string[]): Promise<ParsedChange> {
    const repos = await Promise.all(ws.map(async (w) => {
      const d = await (head ? this.d.diffs : this.d.candidates).diff(w, DIFF_BYTES);
      if (d.truncated) throw new Error(`the diff of ${w.spec.repositoryRef.name} exceeds ${DIFF_BYTES} bytes; it cannot be reviewed completely`);
      return { name: w.spec.repositoryRef.name, head: head ?? "worktree", base: w.status!.baseCommit!, patch: d.patch };
    }));
    const change = buildChange(repos);
    const files = this.d.readers.forWorkspaces(ws);
    const headText = (f: ChangedFile) => files.readFile(ws.length > 1 ? `${f.repository}/${f.path}` : f.path).catch(() => undefined);
    await classifyGenerated(change.files, generated, headText, (path, glob) => matchesGlob(path, glob));
    // The scope is part of what the agent is shown, so a scope change is a new manifest version.
    const scope = createHash("sha256").update(JSON.stringify(change.manifest.files.map((f) => [f.path, f.inScope, f.scopeReason ?? ""]))).digest("hex").slice(0, 8);
    change.manifest.version = `${change.manifest.version}~${scope}`;
    return change;
  }
}
