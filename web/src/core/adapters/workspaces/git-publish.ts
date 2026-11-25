import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { BranchPublisher, ExportIngestor, SecretResolver } from "../../ports/index.ts";
import { GitBundleIngest } from "./git-export.ts";
import { FACTORY_GIT_IDENTITY, GIT_HARDENING, gitRemote } from "./git-auth.ts";

const execFileP = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * ADR-0023 / ADR-0080 §13: commits the workspace as "Software Factory" and pushes its branch **from a factory-owned
 * bare mirror**, not from the agent-writable workspace (SEC-2/SEC-3). The commit is exported as a bundle, ingested with
 * `fsck`/limits (never checked out), and only that push carries the repository token.
 *
 * ADR-0091: the factory owns its `factory/*` branch, so a moved remote head (e.g. a human's "Update branch" merge on
 * the pull request) must not block publication. The push replaces the branch with a **compare-and-swap lease**: it is
 * forced against the head read just before the push, and fails only if the branch moved again in between (the delivery
 * then retries). The factory never integrates foreign commits into the candidate; the base is reconciled through
 * ADR-0053, and the workspace stays the single source of truth for the branch.
 */
export class GitBranchPublisher implements BranchPublisher {
  private readonly secrets: SecretResolver;
  private readonly ingest: ExportIngestor;
  constructor(secrets: SecretResolver, ingest: ExportIngestor = new GitBundleIngest()) {
    this.secrets = secrets;
    this.ingest = ingest;
  }

  async publish(ws: Workspace, repo: Repository, message: string) {
    const dir = ws.status?.path;
    if (!dir) throw new Error(`workspace ${ws.metadata.name} has no path`);
    const { url, env, authEnv } = gitRemote(repo, this.secrets);
    const local = async (...args: string[]) => (await execFileP("git", [...GIT_HARDENING, ...args], { cwd: dir, env, maxBuffer: MAX_BUFFER })).stdout.trim();

    await local("add", "-A");
    const staged = await local("diff", "--cached", "--name-only");
    // ADR-0053: a base merge left by the integrator is completed by this commit, even without further changes.
    const merging = existsSync(join(await local("rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
    if (staged || merging) await local(...FACTORY_GIT_IDENTITY, "commit", "-q", "--no-edit", "--no-verify", "-m", message);
    const branch = ws.spec.branch;
    const commit = await local("rev-parse", "HEAD");

    const scratch = await mkdtemp(join(tmpdir(), "factory-publish-"));
    try {
      const bundle = join(scratch, "candidate.bundle");
      const mirror = join(scratch, "mirror.git");
      await local("bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
      const exported = await this.ingest.ingest({ bundlePath: bundle, mirrorPath: mirror });
      // Read the head to replace, then push with the lease. The push runs in the factory-owned mirror: no agent-writable
      // config, and the token reaches only this process.
      const remote = await this.remoteHead(mirror, url, branch, authEnv);
      await execFileP("git", [...GIT_HARDENING, "push", "--quiet", "--no-verify",
        `--force-with-lease=refs/heads/${branch}:${remote}`, url, `${exported.ref}:refs/heads/${branch}`],
        { cwd: mirror, env: authEnv, maxBuffer: MAX_BUFFER });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return { branch, commit, pushed: true };
  }

  /** The remote head of `branch`, or "" when it does not exist yet (the lease then requires it to still not exist). */
  private async remoteHead(cwd: string, url: string, branch: string, env: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileP("git", [...GIT_HARDENING, "ls-remote", "--heads", url, `refs/heads/${branch}`], { cwd, env, maxBuffer: MAX_BUFFER });
    return stdout.trim().split(/\s+/)[0] ?? "";
  }
}
