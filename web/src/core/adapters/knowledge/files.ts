import { access } from "node:fs/promises";
import type { KnowledgeSource } from "../../model/kinds.ts";
import type { KnowledgeHit, KnowledgeSourceSearch } from "../../ports/index.ts";
import { runRipgrep } from "../codesearch/ripgrep.ts";
import { resolveLocalPath } from "../fs/paths.ts";

/** ADR-0030 `type: files`: ripgrep over a local folder of docs (Markdown, runbooks, …). Read-only by construction. */
export class FilesKnowledgeSearch implements KnowledgeSourceSearch {
  readonly type = "files";
  private readonly root: string;
  private readonly bin: string;
  /** `root`: base for relative `local.path` (the factory root). */
  constructor(root: string, bin = "rg") {
    this.root = root;
    this.bin = bin;
  }

  async search(source: KnowledgeSource, terms: string[], limit: number): Promise<KnowledgeHit[]> {
    const p = source.spec.local?.path;
    if (!p) throw new Error(`knowledge source ${source.metadata.name} has no spec.local.path`);
    const dir = resolveLocalPath(this.root, p);
    await access(dir);
    const hits: KnowledgeHit[] = [];
    for (const term of terms) {
      if (hits.length >= limit) break;
      const args = ["--json", "-i", "-F", "-C", "2", "--max-count", "2", "--max-filesize", "1M"];
      for (const g of source.spec.include ?? []) args.push("-g", g);
      for (const g of source.spec.exclude ?? []) args.push("-g", `!${g}`);
      args.push("--", term, ".");
      // Collect matches and their context lines per file, then cut a small excerpt around each match.
      const files = new Map<string, Map<number, string>>();
      const matches: { path: string; line: number }[] = [];
      for (const raw of await runRipgrep(this.bin, args, dir)) {
        try {
          const ev = JSON.parse(raw);
          if (ev.type !== "match" && ev.type !== "context") continue;
          const path = String(ev.data.path.text).replace(/^\.\//, "");
          const lines = files.get(path) ?? new Map<number, string>();
          lines.set(ev.data.line_number, String(ev.data.lines.text ?? "").replace(/\n$/, ""));
          files.set(path, lines);
          if (ev.type === "match") matches.push({ path, line: ev.data.line_number });
        } catch {
          // ignore non-JSON lines
        }
      }
      for (const m of matches) {
        if (hits.length >= limit) break;
        const lines = files.get(m.path)!;
        const excerpt = [-2, -1, 0, 1, 2].map((d) => lines.get(m.line + d)).filter((l) => l !== undefined).join("\n");
        hits.push({ kind: "doc", title: `${source.metadata.name}: ${m.path}`, ref: `${source.metadata.name}:${m.path}:${m.line}`, excerpt: excerpt.slice(0, 800) });
      }
    }
    return hits;
  }
}
