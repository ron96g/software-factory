import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../../model/kinds.ts";
import type { Repository } from "../../model/kinds.ts";
import { GIT_HARDENING, gitLocalEnv } from "./git-auth.ts";
import type { CodeHit, CodeSearch, CodeSearcher, FileReader, WorkspaceReaderFactory } from "../../ports/index.ts";

const execFileP = promisify(execFile);
const MAX_FILE = 200_000;

/**
 * Read-only, path-guarded access to Ready workspaces (ADR-0021) without a sandbox. With several workspaces, paths are
 * prefixed with the repository name (`<repo>/<path>`); with one, they're plain repository paths.
 */
export class LocalWorkspaceReaders implements WorkspaceReaderFactory {
  private readonly search: CodeSearch;
  constructor(search: CodeSearch) {
    this.search = search;
  }

  forWorkspaces(workspaces: Workspace[]): FileReader & CodeSearcher {
    const ready = workspaces.filter((w) => w.status?.phase === "Ready" && w.status.path);
    const multi = ready.length > 1;
    const search = this.search;

    const locate = (p: string): { ws: Workspace; rel: string } => {
      if (!ready.length) throw new Error("no Ready workspace");
      let ws = ready[0];
      let rest = p.replace(/^\.?\//, "");
      if (multi) {
        const [repo, ...tail] = rest.split("/");
        const found = ready.find((w) => w.spec.repositoryRef.name === repo);
        if (!found) throw new Error(`unknown repository prefix "${repo}" (use <repo>/<path>)`);
        ws = found;
        rest = tail.join("/");
      }
      const root = ws.status!.path!;
      const full = resolve(root, rest);
      const rel = relative(root, full);
      if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/)[0] === ".git") throw new Error(`path escapes the workspace: ${p}`);
      return { ws, rel };
    };
    const prefix = (ws: Workspace, path: string) => (multi ? `${ws.spec.repositoryRef.name}/${path}` : path);

    const api: FileReader & CodeSearcher = {
      async readFile(p: string): Promise<string> {
        const { ws, rel } = locate(p);
        // Lexical checks aren't enough: a committed symlink (e.g. link -> ~/.ssh) must not lead outside the workspace.
        const root = await realpath(ws.status!.path!);
        const real = await realpath(resolve(ws.status!.path!, rel));
        const realRel = relative(root, real);
        if (realRel.startsWith("..") || isAbsolute(realRel) || realRel.split(/[\\/]/)[0] === ".git") {
          throw new Error(`path escapes the workspace (via symlink): ${p}`);
        }
        const text = await readFile(real, "utf8");
        return text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n…[file truncated]` : text;
      },
      async listFiles(glob?: string): Promise<string[]> {
        const re = glob ? new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")}$`) : null;
        const out: string[] = [];
        for (const ws of ready) {
          // The workspace is agent-writable: its git config (e.g. core.fsmonitor) must not run here (SEC-2).
          const { stdout } = await execFileP("git", [...GIT_HARDENING, "ls-files", "--cached", "--others", "--exclude-standard"],
            { cwd: ws.status!.path!, env: gitLocalEnv(), maxBuffer: 32 * 1024 * 1024 });
          for (const f of stdout.split("\n")) {
            const name = f && prefix(ws, f);
            if (name && (!re || re.test(name))) out.push(name);
          }
        }
        return out;
      },
      async searchCode(query: string, o: { glob?: string; maxHits?: number; context?: number } = {}): Promise<CodeHit[]> {
        const hits: CodeHit[] = [];
        for (const ws of ready) {
          const repo = { metadata: { name: ws.spec.repositoryRef.name }, spec: { index: o.glob ? { include: [o.glob] } : {} } } as unknown as Repository;
          hits.push(...(await search.search(repo, ws.status!.path!, { terms: [query], maxHitsPerTerm: o.maxHits ?? 40 })));
        }
        const selected = hits.slice(0, o.maxHits ?? 40);
        if (!o.context) return selected;
        const files = new Map<string, Promise<string[] | undefined>>();
        return Promise.all(selected.map(async (hit) => {
          const ws = ready.find((w) => w.spec.repositoryRef.name === hit.repository);
          if (!ws) return hit;
          const key = `${hit.repository}/${hit.path}`;
          if (!files.has(key)) files.set(key, api.readFile(prefix(ws, hit.path)).then((t) => t.split("\n"), () => undefined));
          const lines = await files.get(key)!;
          if (!lines) return hit;
          const context: [number, string][] = [];
          for (let n = Math.max(1, hit.line - o.context!); n <= Math.min(lines.length, hit.line + o.context!); n++) {
            if (n !== hit.line) context.push([n, lines[n - 1]]);
          }
          return { ...hit, context };
        }));
      },
    };
    return api;
  }
}
