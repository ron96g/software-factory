import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { BranchPublisher, SecretResolver } from "../../ports/index.ts";
import { FACTORY_GIT_IDENTITY, gitRemote } from "./git-auth.ts";

const execFileP = promisify(execFile);

/**
 * ADR-0023: commits the workspace as "Software Factory" and pushes its branch to the repository's git URL.
 * The token is passed via GIT_CONFIG_* environment variables (never on the command line, never in the remote URL).
 */
export class GitBranchPublisher implements BranchPublisher {
  private readonly secrets: SecretResolver;
  constructor(secrets: SecretResolver) {
    this.secrets = secrets;
  }

  async publish(ws: Workspace, repo: Repository, message: string) {
    const dir = ws.status?.path;
    if (!dir) throw new Error(`workspace ${ws.metadata.name} has no path`);
    const { url, env } = gitRemote(repo, this.secrets);
    const git = async (...args: string[]) => (await execFileP("git", args, { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

    await git("add", "-A");
    const staged = await git("diff", "--cached", "--name-only");
    // ADR-0053: a base merge left by the integrator is completed by this commit, even without further changes.
    const merging = existsSync(join(await git("rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
    if (staged || merging) await git(...FACTORY_GIT_IDENTITY, "commit", "-q", "--no-edit", "-m", message);
    const branch = ws.spec.branch;
    await git("push", "--quiet", url, `HEAD:refs/heads/${branch}`);
    return { branch, commit: await git("rev-parse", "HEAD"), pushed: true };
  }
}
