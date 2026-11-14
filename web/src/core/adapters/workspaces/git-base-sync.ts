import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { BaseConflictDetector, BaseConflictReport, SecretResolver, WorkspaceIntegrator } from "../../ports/index.ts";
import { FACTORY_GIT_IDENTITY, gitRemote } from "./git-auth.ts";

const execFileP = promisify(execFile);
const MARKER = "^(<<<<<<<|>>>>>>>)( |$)";
// Repository hooks (e.g. post-checkout) must not run for the factory's own bookkeeping.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const lines = (s: string, sep = "\n") => s.split(sep).map((l) => l.trim()).filter(Boolean);

/**
 * ADR-0053 git backend (any runtime whose workspace is a git checkout, like the publisher): compares a workspace with the remote base branch and merges that base into it.
 * Detection never touches the workspace: the candidate (working tree incl. an unfinished merge) is written as a
 * dangling commit through a temporary index and trial-merged in a throwaway worktree (works with git < 2.38).
 */
export class GitBaseSync implements BaseConflictDetector, WorkspaceIntegrator {
  private readonly secrets: SecretResolver;
  constructor(secrets: SecretResolver) {
    this.secrets = secrets;
  }

  async detect(ws: Workspace, repo: Repository, baseBranch: string): Promise<BaseConflictReport> {
    const dir = pathOf(ws);
    const { url, env } = gitRemote(repo, this.secrets);
    const git = runner(env);
    // A named ref keeps the fetched base alive until the integrator merges it.
    const ref = `refs/factory/bases/${ws.metadata.name}`;
    await git(dir, "fetch", "--quiet", "--no-tags", url, `+refs/heads/${baseBranch}:${ref}`);
    const baseCommit = await git(dir, "rev-parse", ref);
    const candidate = await this.candidate(git, dir);
    const markers = ws.status?.baseCommit ? await markersIn(git, dir, ws.status.baseCommit, candidate) : [];
    if (await isAncestor(git, dir, baseCommit, candidate)) return { baseCommit, conflicts: markers };
    const conflicts = await trialMerge(git, dir, candidate, baseCommit);
    return { baseCommit, conflicts: [...new Set([...conflicts, ...markers])].sort() };
  }

  async integrate(ws: Workspace, _repo: Repository, baseCommit: string) {
    const dir = pathOf(ws);
    const git = runner({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" } as unknown as NodeJS.ProcessEnv);
    await git(dir, "cat-file", "-e", `${baseCommit}^{commit}`);
    const done = async (conflicts: string[]) => ({ baseCommit, headCommit: await git(dir, "rev-parse", "HEAD"), conflicts });
    if (await isAncestor(git, dir, baseCommit, "HEAD")) return done(await markersIn(git, dir, baseCommit));
    const pending = await git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").catch(() => "");
    if (pending === baseCommit) return done(await markersIn(git, dir, baseCommit)); // re-entry after a crash
    if (pending) {
      // The base moved again after an earlier merge: finish that merge first, but never commit leftover markers.
      const left = ws.status?.baseCommit ? await markersIn(git, dir, ws.status.baseCommit) : [];
      if (left.length) throw new Error(`workspace ${ws.metadata.name} still has conflict markers from merging ${pending.slice(0, 10)}: ${left.join(", ")}`);
      await git(dir, "add", "-A");
      await git(dir, ...FACTORY_GIT_IDENTITY, ...NO_HOOKS, "commit", "-q", "--no-edit");
    }

    await git(dir, "add", "-A");
    if (await git(dir, "diff", "--cached", "--name-only")) {
      await git(dir, ...FACTORY_GIT_IDENTITY, ...NO_HOOKS, "commit", "-q", "-m", `Work in progress before merging ${baseCommit.slice(0, 10)}`);
    }
    let conflicts: string[] = [];
    try {
      await git(dir, ...FACTORY_GIT_IDENTITY, ...NO_HOOKS, "merge", "--no-ff", "--no-commit", "--quiet", baseCommit);
    } catch (e) {
      conflicts = lines(await git(dir, "diff", "--name-only", "--diff-filter=U"));
      if (!conflicts.length) throw e;
      // Stage the files with their markers: the index stays merge-free for every other git tool; the publisher
      // completes the merge commit once markers are gone (detection reports leftovers as conflicts).
      await git(dir, "add", "--", ...conflicts);
    }
    return done(conflicts);
  }

  private async candidate(git: Git, dir: string): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "factory-index-"));
    try {
      const index = { GIT_INDEX_FILE: join(tmp, "index") };
      await git.with(index)(dir, "read-tree", "HEAD");
      await git.with(index)(dir, "add", "-A");
      const tree = await git.with(index)(dir, "write-tree");
      const merging = await git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").catch(() => "");
      return await git(dir, ...FACTORY_GIT_IDENTITY, "commit-tree", tree, "-p", "HEAD", ...(merging ? ["-p", merging] : []), "-m", "factory candidate");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

type GitFn = (cwd: string, ...args: string[]) => Promise<string>;
type Git = GitFn & { with(extra: Record<string, string>): GitFn };

function runner(env: NodeJS.ProcessEnv): Git {
  const make = (e: NodeJS.ProcessEnv): GitFn => async (cwd, ...args) =>
    (await execFileP("git", args, { cwd, env: e, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  return Object.assign(make(env), { with: (extra: Record<string, string>) => make({ ...env, ...extra }) });
}

function pathOf(ws: Workspace): string {
  const dir = ws.status?.path;
  if (!dir) throw new Error(`workspace ${ws.metadata.name} has no path`);
  return dir;
}

async function isAncestor(git: Git, dir: string, a: string, b: string): Promise<boolean> {
  return git(dir, "merge-base", "--is-ancestor", a, b).then(() => true, () => false);
}

async function trialMerge(git: Git, dir: string, candidate: string, baseCommit: string): Promise<string[]> {
  const tmp = await mkdtemp(join(tmpdir(), "factory-merge-"));
  const wt = join(tmp, "wt");
  try {
    await git(dir, ...NO_HOOKS, "worktree", "add", "--detach", "--quiet", wt, candidate);
    try {
      await git(wt, ...FACTORY_GIT_IDENTITY, ...NO_HOOKS, "merge", "--no-commit", "--no-ff", "--quiet", baseCommit);
      return [];
    } catch (e) {
      const unmerged = lines(await git(wt, "diff", "--name-only", "--diff-filter=U"));
      if (!unmerged.length) throw e;
      return unmerged;
    }
  } finally {
    await git(dir, "worktree", "remove", "--force", wt).catch(() => "");
    await rm(tmp, { recursive: true, force: true });
    await git(dir, "worktree", "prune").catch(() => "");
  }
}

/** Files changed since `from` (in `tree`, or the working tree) that still contain conflict markers. */
async function markersIn(git: Git, dir: string, from: string, tree?: string): Promise<string[]> {
  const changed = lines(await git(dir, "diff", "--name-only", "-z", from, ...(tree ? [tree] : []), "--"), "\0");
  if (!changed.length) return [];
  const out = await git(dir, "grep", "-l", "-I", "-E", MARKER, ...(tree ? [tree] : []), "--", ...changed).catch(() => "");
  return lines(out).map((l) => (tree && l.startsWith(`${tree}:`) ? l.slice(tree.length + 1) : l));
}
