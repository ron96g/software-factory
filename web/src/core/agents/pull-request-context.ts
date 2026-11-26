import type { CandidateDiffReader, ContextProvider, ContextSection, ExecutionContext } from "../ports/index.ts";

/**
 * ADR-0094: the pull request under review, as the diff of each pinned workspace against its merge-base. Analysis agents
 * have no sandbox (no `git_diff`), so the diff is context; read tools cover the surrounding code.
 */
export function pullRequestContext(diffs: CandidateDiffReader, maxBytes = 60_000): ContextProvider {
  return {
    name: "pull-request",
    appliesTo: (ctx) => !!ctx.workItem.spec.pullRequest && ctx.workspaces.some((w) => w.spec.checkout),
    async provide(ctx: ExecutionContext): Promise<ContextSection[]> {
      const pr = ctx.workItem.spec.pullRequest!;
      const sections: ContextSection[] = [];
      for (const ws of ctx.workspaces.filter((w) => w.spec.checkout)) {
        const repo = ws.spec.repositoryRef.name;
        const d = await diffs.diff(ws, maxBytes);
        sections.push({
          title: `Pull request #${pr.number} in ${repo} (head ${pr.headSha.slice(0, 12)}, base ${pr.baseRef} @ ${ws.status?.baseCommit?.slice(0, 12)})`,
          content: [
            "Review exactly this change. Line numbers of the head version are the `+` side of each hunk header; only lines inside a hunk can carry an inline comment. Use read tools for surrounding code.",
            "```text", d.stat.trim(), "```",
            "```diff", d.patch, "```",
            d.truncated ? `The diff is truncated at ${maxBytes} bytes: read the remaining files listed above with read_file.` : "",
          ].filter(Boolean).join("\n"),
          source: "pull-request",
          revision: `${repo}@${pr.headSha}`,
        });
      }
      return sections;
    },
  };
}
