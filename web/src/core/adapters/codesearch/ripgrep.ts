import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { access } from "node:fs/promises";
import type { Repository } from "../../model/kinds.ts";
import type { CodeHit, CodeSearch, CodeSearchQuery, WorkspaceProvider } from "../../ports/index.ts";

/** ADR-0008: ripgrep over a local checkout. Fixed-string, case-insensitive; read-only by construction. */
export class RipgrepCodeSearch implements CodeSearch {
  private readonly bin: string;
  constructor(bin = "rg") {
    this.bin = bin;
  }
  async search(repo: Repository, root: string, q: CodeSearchQuery): Promise<CodeHit[]> {
    const hits: CodeHit[] = [];
    const max = q.maxHitsPerTerm ?? 8;
    for (const term of q.terms) {
      const args = ["--json", "-i", "-F", "--max-count", "3", "--max-filesize", "1M"];
      for (const g of repo.spec.index?.include ?? []) args.push("-g", g);
      for (const g of repo.spec.index?.exclude ?? []) args.push("-g", `!${g}`);
      for (const g of ["!node_modules", "!.next", "!.venv", "!*.lock", "!package-lock.json", "!.serena"]) args.push("-g", g);
      args.push("--", term, ".");
      const lines = await run(this.bin, args, root);
      let n = 0;
      for (const line of lines) {
        if (n >= max) break;
        try {
          const ev = JSON.parse(line);
          if (ev.type !== "match") continue;
          hits.push({
            repository: repo.metadata.name,
            path: String(ev.data.path.text).replace(/^\.\//, ""),
            line: ev.data.line_number,
            text: String(ev.data.lines.text ?? "").trim().slice(0, 200),
            term,
          });
          n++;
        } catch {
          // ignore non-JSON lines
        }
      }
    }
    return hits;
  }
}

function run(bin: string, args: string[], cwd: string): Promise<string[]> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { cwd });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 || code === 1 ? ok(out.split("\n").filter(Boolean)) : fail(new Error(`${bin} exited ${code}`))));
  });
}

/** MVP: only `spec.local.path` (relative to the factory root). Git clones come with v0.3. */
export class LocalWorkspaceProvider implements WorkspaceProvider {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async checkout(repo: Repository): Promise<string> {
    const p = repo.spec.local?.path;
    if (!p) throw new Error(`repository ${repo.metadata.name} has no spec.local.path (git checkout arrives in v0.3)`);
    const dir = isAbsolute(p) ? p : resolve(this.root, p);
    await access(dir);
    return dir;
  }
}
