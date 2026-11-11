import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { PreparedWorkspace, WorkspaceCleaner, WorkspacePreparer, WorkspaceSupport, WorkspaceSweeper } from "../../ports/index.ts";
import { runScrubbed } from "../sandbox/process.ts";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/**
 * ADR-0021 host backend: one Git worktree per (work item, repository) under `<workspacesDir>/<item>/<repo>`,
 * on branch `spec.branch`, forked from `spec.baseRef` (default: the checkout's HEAD). Setup runs once.
 */
export class GitWorktreeWorkspaces implements WorkspacePreparer, WorkspaceCleaner, WorkspaceSupport, WorkspaceSweeper {
  private readonly root: string;
  private readonly dir: string;
  constructor(o: { definitionsRoot: string; workspacesDir: string }) {
    this.root = o.definitionsRoot;
    this.dir = o.workspacesDir;
  }

  supports(repo: Repository): boolean {
    return !!repo.spec.local?.path;
  }

  private source(repo: Repository): string {
    const p = repo.spec.local?.path;
    if (!p) throw new Error(`repository ${repo.metadata.name} has no spec.local.path (git clone arrives with isolated runtimes)`);
    return isAbsolute(p) ? p : resolve(this.root, p);
  }

  private pathOf(ws: Workspace): string {
    return this.guard(join(this.dir, ws.spec.workItemRef.name, ws.spec.repositoryRef.name));
  }

  /** Every path we create or delete must be strictly inside workspacesDir (rm -rf safety). */
  private guard(p: string): string {
    const full = resolve(p);
    const rel = relative(resolve(this.dir), full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing path outside the workspaces dir: ${p}`);
    return full;
  }

  async prepare(ws: Workspace, repo: Repository): Promise<PreparedWorkspace> {
    const source = this.source(repo);
    const path = this.pathOf(ws);
    let setupLog = ws.status?.setupLog;
    if (!existsSync(join(path, ".git"))) {
      await mkdir(join(this.dir, ws.spec.workItemRef.name), { recursive: true });
      await git(source, "worktree", "prune");
      const exists = await git(source, "branch", "--list", ws.spec.branch);
      const base = ws.spec.baseRef ?? "HEAD";
      await git(source, "worktree", "add", ...(exists ? [path, ws.spec.branch] : ["-b", ws.spec.branch, path, base]));
    }
    // Setup re-runs until it completed once (a crash mid-setup must not yield a Ready workspace without deps).
    if (!ws.status?.setupCompleted) {
      const logs: string[] = [];
      for (const cmd of ws.spec.setup ?? []) {
        const r = await runScrubbed(cmd, path, 15 * 60_000);
        logs.push(`$ ${cmd}\nexit ${r.exitCode} (${r.durationMs} ms)\n${(r.stdout + r.stderr).slice(-4000)}`);
        if (r.exitCode !== 0) throw new Error(`setup failed: ${cmd} (exit ${r.exitCode})\n${(r.stderr || r.stdout).slice(-1500)}`);
      }
      setupLog = logs.join("\n\n") || undefined;
    }
    // Pinned once: an existing status.baseCommit wins over recomputation.
    const baseCommit = ws.status?.baseCommit ?? (await git(path, "merge-base", "HEAD", ws.spec.baseRef ?? (await git(source, "rev-parse", "HEAD"))));
    return { path, baseCommit, headCommit: await git(path, "rev-parse", "HEAD"), preparedBy: "host-git-worktree", setupLog, setupCompleted: true };
  }

  async sweep(live: { workItem: string; repository: string }[]): Promise<string[]> {
    const removed = await sweepWorktrees(this.dir, new Set(live.map((l) => `${l.workItem}/${l.repository}`)), (p) => this.guard(p));
    return removed; // stale `git worktree` metadata is pruned on the next prepare
  }

  async remove(ws: Workspace, repo: Repository | null): Promise<void> {
    const path = this.guard(ws.status?.path ?? this.pathOf(ws));
    if (!existsSync(path)) return;
    const source = repo?.spec.local?.path ? this.source(repo) : path;
    // The branch is kept (it may back a pull request); only the working copy goes.
    await git(source, "worktree", "remove", "--force", path).catch(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    });
  }
}

export async function sweepWorktrees(dir: string, live: Set<string>, guard: (p: string) => string): Promise<string[]> {
  const { readdir, rm } = await import("node:fs/promises");
  const removed: string[] = [];
  if (!existsSync(dir)) return removed;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const itemDir = join(dir, item.name);
    if (existsSync(join(itemDir, ".git"))) continue; // pre-ADR-0021 layout: left alone
    for (const repo of await readdir(itemDir, { withFileTypes: true })) {
      if (!repo.isDirectory() || live.has(`${item.name}/${repo.name}`)) continue;
      const path = guard(join(itemDir, repo.name));
      if (!existsSync(join(path, ".git"))) continue; // only remove what looks like one of our worktrees
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}
