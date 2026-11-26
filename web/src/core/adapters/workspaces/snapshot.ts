import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Workspace, WorkspaceFileChange } from "../../model/kinds.ts";
import type { WorkspaceCheckpoint, WorkspaceCheckpointDiff, WorkspaceSnapshotter } from "../../ports/index.ts";
import { GIT_HARDENING } from "./git-auth.ts";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Fingerprint = the Git tree of the working copy: tracked and non-ignored untracked contents, deletions, executable
 * bits and symlinks (never followed). Git hashes in C and reuses the index's stat cache, so unchanged files are not
 * re-read. A throwaway index and object directory keep the workspace's own index and object store untouched.
 */
export class GitWorkspaceSnapshotter implements WorkspaceSnapshotter {
  async fingerprint(workspace: Workspace): Promise<string> {
    const cwd = workspace.status?.path;
    if (!cwd) throw new Error(`workspace ${workspace.metadata.name} has no path`);
    const git = async (args: string[], env?: NodeJS.ProcessEnv) =>
      (await exec("git", [...GIT_HARDENING, ...args], { cwd, maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) })).stdout;
    const gitPath = async (name: string) => resolve(cwd, (await git(["rev-parse", "--git-path", name])).trim());
    const scratch = await mkdtemp(join(tmpdir(), "factory-snapshot-"));
    try {
      const index = join(scratch, "index");
      const objects = join(scratch, "objects");
      await mkdir(objects);
      await copyFile(await gitPath("index"), index).catch(() => {}); // stat cache; a missing index just means a full hash
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: index,
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: await gitPath("objects"),
        GIT_OPTIONAL_LOCKS: "0",
        // No user/system config: clean filters (e.g. LFS) and other drivers must not run or change contents.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
      };
      await git(["add", "-A", "--", "."], env);
      const tree = (await git(["write-tree"], env)).trim();
      await this.rejectEscapes(cwd, git, env);
      return tree;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** A tracked path below a symlink that leads outside the workspace would let checks read or write outside it. */
  private async rejectEscapes(cwd: string, git: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>, env: NodeJS.ProcessEnv) {
    const root = await realpath(cwd);
    const links = (await git(["ls-files", "-s", "-z"], env)).split("\0").filter((e) => e.startsWith("120000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
    for (const link of links) {
      const target = await realpath(join(cwd, link)).catch(() => undefined);
      if (!target) continue;
      const rel = relative(root, target);
      if (!(rel.startsWith("..") || isAbsolute(rel)) || !(await stat(target)).isDirectory()) continue;
      if ((await git(["ls-files", "-z", "--cached", "--", `${link}/`])).length) throw new Error(`workspace path escapes through a symlink: ${link}`);
    }
  }
}

/**
 * ADR-0061 §2: a check must leave the candidate as it found it. `capture` records the working tree as a Git tree object
 * in the workspace's own object store (so the handle survives a restart); `restore` writes that tree back and removes
 * the files a check added. Only the paths a check changed are touched, so a restore never rewrites the whole repository.
 * The index is always a throwaway, so the workspace's own index and staging state stay untouched.
 */
export class GitWorkspaceCheckpoint implements WorkspaceCheckpoint, WorkspaceCheckpointDiff {
  async diff(workspace: Workspace, from: string, to: string): Promise<WorkspaceFileChange[]> {
    for (const tree of [from, to]) if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("checkpoint must be a Git tree hash");
    const cwd = this.path(workspace);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" };
    const base = ["diff-tree", "-r", "--no-commit-id", "--no-renames", "-z", from, to];
    const kinds = new Map<string, WorkspaceFileChange["change"]>();
    const status = (await this.git(cwd, [...base.slice(0, -2), "--name-status", from, to], env)).split("\0");
    for (let i = 0; i + 1 < status.length; i += 2) {
      if (!status[i]) break;
      kinds.set(status[i + 1], status[i] === "A" ? "added" : status[i] === "D" ? "deleted" : "modified");
    }
    // `--numstat -z`: "added\tdeleted\tpath\0"; binary files report "-".
    return (await this.git(cwd, [...base.slice(0, -2), "--numstat", from, to], env)).split("\0").filter(Boolean).map((entry) => {
      const [added, deleted, ...rest] = entry.split("\t");
      const path = rest.join("\t");
      return { path, change: kinds.get(path) ?? "modified",
        ...(added === "-" ? {} : { added: Number(added), deleted: Number(deleted) }) };
    });
  }

  async capture(workspace: Workspace): Promise<string> {
    const cwd = this.path(workspace);
    const scratch = await mkdtemp(join(tmpdir(), "factory-checkpoint-"));
    try {
      const env = await this.env(cwd, join(scratch, "index"));
      await this.git(cwd, ["add", "-A", "--", "."], env);
      return (await this.git(cwd, ["write-tree"], env)).trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async restore(workspace: Workspace, checkpoint: string): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/.test(checkpoint)) throw new Error("checkpoint must be a Git tree hash");
    const cwd = this.path(workspace);
    const current = await this.capture(workspace);
    if (current === checkpoint) return false;
    const scratch = await mkdtemp(join(tmpdir(), "factory-checkpoint-"));
    try {
      const env = await this.env(cwd, join(scratch, "index"));
      const changed = (await this.git(cwd, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", checkpoint, current], env))
        .split("\0").filter(Boolean);
      const captured = new Set((await this.git(cwd, ["ls-tree", "-r", "--name-only", "-z", checkpoint], env)).split("\0").filter(Boolean));
      await this.git(cwd, ["read-tree", checkpoint], env);
      const root = await realpath(cwd);
      for (const path of changed) {
        if (!this.safePath(path)) throw new Error(`checkpoint path is not safe to restore: ${path}`);
        // A check can replace a directory with a symlink to outside the workspace; writing through it (checkout-index)
        // or removing through it (rm) would then act outside the candidate (SEC-1). Guard the deepest existing ancestor.
        if (!await this.insideWorkspace(root, join(cwd, path))) throw new Error(`refusing to restore a path outside the workspace: ${path}`);
        if (captured.has(path)) await this.git(cwd, ["checkout-index", "-f", "--", path], env);
        else await rm(join(cwd, path), { force: true }); // the check added it; the candidate never had it
      }
      return true;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private path(workspace: Workspace): string {
    const cwd = workspace.status?.path;
    if (!cwd) throw new Error(`workspace ${workspace.metadata.name} has no path`);
    return cwd;
  }

  private async git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return (await exec("git", [...GIT_HARDENING, ...args], { cwd, maxBuffer: MAX_BUFFER, env })).stdout;
  }

  private async env(cwd: string, index: string): Promise<NodeJS.ProcessEnv> {
    // The captured tree must still be readable when the controller restores it (possibly a later reconcile), so blobs
    // go to the workspace's real object store; the index is a throwaway copy used only as a stat cache.
    const indexPath = (await this.git(cwd, ["rev-parse", "--git-path", "index"], process.env)).trim();
    await copyFile(resolve(cwd, indexPath), index).catch(() => {});
    return {
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
    };
  }

  private safePath(path: string): boolean {
    return !!path && !isAbsolute(path) && !path.split("/").some((part) => part === "..");
  }

  /** True when the deepest existing ancestor of `full` resolves inside `root` (a missing tail is safe: git creates it). */
  private async insideWorkspace(root: string, full: string): Promise<boolean> {
    for (let dir = dirname(full); ; dir = dirname(dir)) {
      const real = await realpath(dir).catch(() => undefined);
      if (real) {
        const rel = relative(root, real);
        return !(rel.startsWith("..") || isAbsolute(rel));
      }
      if (dirname(dir) === dir) return false;
    }
  }
}
