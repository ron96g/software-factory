import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../../model/kinds.ts";
import type { WorkspaceSnapshotter } from "../../ports/index.ts";

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
      (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) })).stdout;
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
