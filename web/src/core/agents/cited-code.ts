import { createHash } from "node:crypto";
import type { ContextProvider, ExecutionContext, WorkspaceReaderFactory } from "../ports/index.ts";
import { findCitations, formatCitation, numbered, readCited, type Citation } from "../code/citations.ts";

export const CITED_CODE_SOURCE = "cited-code";

const LIMITS = { citations: 24, linesPerExcerpt: 40, window: 2, chars: 16_000 };

type Status = "resolved" | "missing-file" | "out-of-range" | "not-readable";

/** Text the run relies on: its inputs, the item's description and team context, and recorded answers. */
function citedText(ctx: ExecutionContext): string {
  const wi = ctx.workItem;
  return [
    wi.spec.description ?? "", wi.spec.context ?? "",
    ...ctx.inputs.map((a) => a.spec.content),
    ...ctx.clarifications.flatMap((c) => c.spec.answers ?? []),
    wi.spec.planning ? JSON.stringify(wi.spec.planning) : "",
  ].join("\n");
}

/**
 * ADR-0057: resolves every code citation the run relies on against its pinned workspaces before the first model
 * step, so agents see the cited lines without a tool call. Locations only: it never judges whether a claim is true.
 * Excerpts are workspace content, like `read_file` results (ADR-0019 §7, ADR-0022).
 */
export function citedCodeContext(readers: WorkspaceReaderFactory): ContextProvider {
  const ready = (ctx: ExecutionContext) => ctx.workspaces.filter((w) => w.status?.phase === "Ready" && w.status.path);
  return {
    name: CITED_CODE_SOURCE,
    appliesTo: (ctx) => ready(ctx).length > 0,
    async provide(ctx) {
      const citations = findCitations(citedText(ctx));
      if (!citations.length) return [];
      const workspaces = ready(ctx);
      const repositories = workspaces.map((w) => w.spec.repositoryRef.name);
      const files = readers.forWorkspaces(workspaces);
      const results: { citation: Citation; status: Status; excerpt?: string }[] = [];
      let chars = 0;
      const resolve = async (c: Citation): Promise<{ citation: Citation; status: Status; excerpt?: string }> => {
        if (c.repository && !repositories.includes(c.repository)) return { citation: c, status: "not-readable" };
        // A bare path is tried in each readable workspace; the first one that has the file wins.
        for (const repository of c.repository ? [c.repository] : repositories) {
          let lines: string[];
          try { lines = await readCited(files, repositories, { repository, path: c.path }); }
          catch (e) {
            if (/escapes/.test(e instanceof Error ? e.message : "")) return { citation: c, status: "not-readable" };
            continue;
          }
          const citation = { ...c, repository };
          if (c.startLine > lines.length) return { citation, status: "out-of-range" };
          const end = Math.min(c.endLine, lines.length, c.startLine + LIMITS.linesPerExcerpt - 1);
          const from = Math.max(1, c.startLine - LIMITS.window);
          const to = Math.min(lines.length, end + LIMITS.window);
          const clipped = end < c.endLine ? `\n… (cited range continues to line ${c.endLine}; read the rest with read_file)` : "";
          return { citation, status: "resolved", excerpt: numbered(lines.slice(from - 1, to), from) + clipped };
        }
        return { citation: c, status: "missing-file" };
      };
      for (const c of citations.slice(0, LIMITS.citations)) {
        const r = await resolve(c);
        if (r.excerpt && chars + r.excerpt.length > LIMITS.chars) {
          results.push({ citation: r.citation, status: r.status });
          continue;
        }
        chars += r.excerpt?.length ?? 0;
        results.push(r);
      }
      const commits = workspaces.map((w) => `${w.spec.repositoryRef.name}@${w.status?.baseCommit?.slice(0, 12) ?? "?"}`);
      const resolved = results.filter((r) => r.status === "resolved");
      const listed = results.filter((r) => r.status === "resolved" && !r.excerpt);
      const unresolved = results.filter((r) => r.status !== "resolved");
      const omitted = citations.slice(LIMITS.citations);
      const content = [
        `The factory resolved the code citations found in this run's inputs against the pinned workspaces (${commits.join(", ")}).`,
        "Code at the pinned commit takes precedence over prose in earlier artifacts, such as older research notes.",
        "An excerpt shows where a citation points; judge yourself whether it supports the claim.",
        ...resolved.filter((r) => r.excerpt).map((r) => `### ${formatCitation(r.citation)}\n\`\`\`\n${r.excerpt}\n\`\`\``),
        ...(listed.length || omitted.length ? [`### Not excerpted (size budget; use read_file)\n${[...listed.map((r) => r.citation), ...omitted].map((c) => `- ${formatCitation(c)}`).join("\n")}`] : []),
        ...(unresolved.length ? [`### Unresolved citations\n${unresolved.map((r) => `- ${formatCitation(r.citation)}: ${r.status}`).join("\n")}`] : []),
      ].join("\n\n");
      const revision = createHash("sha256").update(JSON.stringify([commits, results.map((r) => [formatCitation(r.citation), r.status])])).digest("hex");
      return [{
        title: "Cited code (pinned workspace)", source: CITED_CODE_SOURCE, content, revision,
        counts: { citations: citations.length, resolved: resolved.length, unresolved: unresolved.length, omitted: omitted.length },
      }];
    },
  };
}
