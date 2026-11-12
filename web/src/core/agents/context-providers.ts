import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "../model/kinds.ts";
import type { CodeSearch, ContextProvider, ContextSection, ExecutionContext, WorkspaceProvider } from "../ports/index.ts";

/** ADR-0021: the item's Ready workspace for this repository, else the repository checkout. */
async function rootFor(ctx: ExecutionContext, repo: Repository, workspaces: WorkspaceProvider): Promise<string> {
  const ws = ctx.workspaces.find((w) => w.spec.repositoryRef.name === repo.metadata.name && w.status?.path);
  return ws ? ws.status!.path! : workspaces.checkout(repo);
}

const STOP = new Set(
  "the a an and or but for with from into onto this that these those have has had will would should could can cannot not no yes are was were been be is it its our your their there here when what which who how why where please need needs want wants make made add adds allow allows able use using used new also than then them they you we i me my to of in on at by as if so do does done".split(
    " ",
  ),
);

/** Picks search terms from the work item and answers (identifiers and longer domain words first). */
export function extractTerms(text: string, max = 6): string[] {
  const words = text.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) ?? [];
  const scored = new Map<string, number>();
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[.-]+$/, "");
    if (STOP.has(lw) || lw.length < 4) continue;
    const score = (/[A-Z_]/.test(w.slice(1)) ? 3 : 0) + Math.min(lw.length, 10) / 10 + (scored.get(lw) ?? 0);
    scored.set(lw, score);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/** Enriches runs that use `codebase-research` with ripgrep hits (cited repo:path:line). */
export function codeSearchProvider(workspaces: WorkspaceProvider, search: CodeSearch): ContextProvider {
  return {
    name: "code-search",
    appliesTo: (ctx) => ctx.repositories.length > 0 && ctx.skills.some((s) => s.metadata.name === "codebase-research"),
    async provide(ctx: ExecutionContext): Promise<ContextSection[]> {
      const text = [
        ctx.workItem.spec.title,
        ctx.workItem.spec.description ?? "",
        ctx.workItem.spec.context ?? "",
        ...ctx.clarifications.flatMap((c) => c.spec.answers ?? []),
      ].join("\n");
      const terms = extractTerms(text);
      const sections: ContextSection[] = [];
      const sys = { type: "system" as const, id: "code-search" };
      await ctx.transcript.record({ role: "tool-call", author: sys, content: JSON.stringify({ terms }), meta: { tool: "code-search" } });
      for (const repo of ctx.repositories) {
        try {
          const root = await rootFor(ctx, repo, workspaces);
          const hits = await search.search(repo, root, { terms });
          await ctx.transcript.record({
            role: "tool-result",
            author: sys,
            content: hits.map((h) => `${h.repository}:${h.path}:${h.line} [${h.term}] ${h.text}`).join("\n") || "(no hits)",
            meta: { tool: "code-search", repository: repo.metadata.name },
          });
          const byTerm = new Map<string, string[]>();
          for (const h of hits) byTerm.set(h.term, [...(byTerm.get(h.term) ?? []), `- \`${h.repository}:${h.path}:${h.line}\`: ${h.text}`]);
          for (const [term, lines] of byTerm) {
            sections.push({ title: `Code matches for "${term}" in ${repo.metadata.name}`, content: `### "${term}"\n${lines.join("\n")}`, source: "code-search" });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await ctx.transcript.record({ role: "tool-result", author: sys, content: `error: ${msg}`, meta: { tool: "code-search", repository: repo.metadata.name } });
          sections.push({ title: `Code search unavailable for ${repo.metadata.name}`, content: msg, source: "code-search-error" });
        }
      }
      return sections;
    },
  };
}

/** Adds the repository's key docs (README, architecture) so agents know the codebase's shape. */
export function repositoryDocsProvider(workspaces: WorkspaceProvider, maxChars = 4000): ContextProvider {
  return {
    name: "repository-docs",
    appliesTo: (ctx) =>
      ctx.skills.some((s) => s.metadata.name === "codebase-research") &&
      ctx.repositories.some((r) => r.spec.context?.docs?.length && r.spec.local?.path),
    async provide(ctx) {
      const out: ContextSection[] = [];
      for (const repo of ctx.repositories) {
        for (const doc of repo.spec.context?.docs ?? []) {
          try {
            const root = await rootFor(ctx, repo, workspaces);
            const text = await readFile(join(root, doc), "utf8");
            out.push({ title: `${repo.metadata.name}:${doc}`, content: text.slice(0, maxChars), source: "repository-docs" });
          } catch {
            // missing docs are not an error
          }
        }
      }
      return out;
    },
  };
}
