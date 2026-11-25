import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { PreparedWorkspace, SecretResolver, WorkspaceCleaner, WorkspaceProbe, WorkspacePreparer, WorkspaceSupport, WorkspaceSweeper } from "../../ports/index.ts";
import { runScrubbed } from "../sandbox/process.ts";
import { resolveLocalPath } from "../fs/paths.ts";
import { GIT_HARDENING, gitLocalEnv, gitRemote } from "./git-auth.ts";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", [...GIT_HARDENING, ...args], { cwd, env: gitLocalEnv(), maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/** A directory git can work in: a clone (`.git` directory) or a worktree (`.git` file). */
const isWorkTree = (path: string): boolean => existsSync(join(path, ".git"));

/**
 * ADR-0021 host backend: one Git worktree per (work item, repository) under `<workspacesDir>/<item>/<repo>`,
 * on branch `spec.branch`, forked from `spec.baseRef` (default: the checkout's HEAD). Setup runs once.
 */
export class GitWorktreeWorkspaces implements WorkspacePreparer, WorkspaceCleaner, WorkspaceSupport, WorkspaceSweeper, WorkspaceProbe {
  private readonly root: string;
  private readonly dir: string;
  private readonly secrets: SecretResolver;
  constructor(o: { definitionsRoot: string; workspacesDir: string; secrets: SecretResolver }) {
    this.root = o.definitionsRoot;
    this.dir = o.workspacesDir;
    this.secrets = o.secrets;
  }

  supports(repo: Repository): boolean {
    return !!repo.spec.local?.path;
  }

  /** ADR-0021: a `Ready` workspace whose files are gone (a prune, a manual cleanup) is reported missing. */
  exists(ws: Workspace): boolean {
    return !!ws.status?.path && isWorkTree(ws.status.path);
  }

  private sourcePath(repo: Repository): string {
    const p = repo.spec.local?.path;
    if (!p) throw new Error(`repository ${repo.metadata.name} has no spec.local.path; declare where the checkout lives (the factory clones spec.git.url into it when it is absent)`);
    return resolveLocalPath(this.root, p);
  }

  /**
   * ADR-0021 addendum: the checkout the worktrees fork from. When the declared path is absent the factory
   * **clones** the repository itself (ADR-0008 already allows a `git clone` behind the same ports), so a
   * missing operator checkout is a cold cache instead of an item that fails with `spawn git ENOENT`.
   */
  private async source(repo: Repository): Promise<string> {
    const path = this.sourcePath(repo);
    if (await this.isUsableCheckout(path)) return path;
    // An empty directory is cloned into; anything else is left alone (a leftover partial clone needs a human).
    if (existsSync(path) && readdirSync(path).length > 0) {
      throw new Error(`repository ${repo.metadata.name}: spec.local.path ${path} exists but is not a usable git checkout; remove it to let the factory clone, or point spec.local.path somewhere else`);
    }
    return this.clone(repo, path);
  }

  /** A checkout git can fork a worktree from: a `.git` (directory or file) with a commit at HEAD. */
  private async isUsableCheckout(path: string): Promise<boolean> {
    if (!isWorkTree(path)) return false;
    try {
      await git(path, "rev-parse", "--verify", "HEAD");
      return true;
    } catch {
      return false;
    }
  }

  /** SEC-3: the token travels in the environment, never in the clone's configuration or its remote URL. */
  private async clone(repo: Repository, path: string): Promise<string> {
    const { url, authEnv } = gitRemote(repo, this.secrets);
    await mkdir(dirname(path), { recursive: true });
    try {
      await execFileP("git", [...GIT_HARDENING, "clone", "--quiet", url, path], { env: authEnv, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`repository ${repo.metadata.name}: cloning ${url} into ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return path;
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
    const source = await this.source(repo);
    const path = this.pathOf(ws);
    let setupLog = ws.status?.setupLog;
    if (!isWorkTree(path)) {
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
    // ADR-0021: with an empty store there is nothing to compare against, so the sweep cannot tell an orphaned worktree
    // from one another instance still owns (a test booting a factory, a dev instance on a different database). Refuse to
    // delete anything rather than wipe the workspaces of a factory that is running.
    if (!live.length) return [];
    const removed = await sweepWorktrees(this.dir, new Set(live.map((l) => `${l.workItem}/${l.repository}`)), (p) => this.guard(p));
    return removed; // stale `git worktree` metadata is pruned on the next prepare
  }

  async remove(ws: Workspace, repo: Repository | null): Promise<void> {
    const path = this.guard(ws.status?.path ?? this.pathOf(ws));
    if (!existsSync(path)) return;
    // Never clone just to delete: use the checkout only when it is already usable.
    const declared = repo?.spec.local?.path ? this.sourcePath(repo) : undefined;
    const source = declared && (await this.isUsableCheckout(declared)) ? declared : path;
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
