import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../../model/kinds.ts";
import type { WorkspaceSnapshotter } from "../../ports/index.ts";

const exec = promisify(execFile);

/** Hash tracked and non-ignored untracked contents, including deletions, executable bits and symlinks. */
export class GitWorkspaceSnapshotter implements WorkspaceSnapshotter {
  async fingerprint(workspace: Workspace): Promise<string> {
    const cwd = workspace.status?.path;
    if (!cwd) throw new Error(`workspace ${workspace.metadata.name} has no path`);
    const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 16 * 1024 * 1024 });
    const root = await realpath(cwd);
    const hash = createHash("sha256");
    for (const name of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
      hash.update(JSON.stringify(name));
      const path = join(cwd, name);
      let stat;
      try {
        const parent = relative(root, await realpath(dirname(path)));
        if (parent.startsWith("..") || isAbsolute(parent)) throw new Error(`workspace path escapes through a symlink: ${name}`);
        stat = await lstat(path);
      }
      catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        hash.update("deleted\0");
        continue;
      }
      if (stat.isSymbolicLink()) hash.update(`symlink:${await readlink(path)}\0`);
      else if (stat.isFile()) {
        hash.update(`file:${stat.mode & 0o111}:`);
        hash.update(createHash("sha256").update(await readFile(path)).digest());
      } else throw new Error(`cannot snapshot non-file workspace entry ${name}`);
    }
    return hash.digest("hex");
  }
}
