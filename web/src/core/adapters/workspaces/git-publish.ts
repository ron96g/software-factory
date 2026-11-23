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

/**
 * ADR-0023 / ADR-0080 §13: commits the workspace as "Software Factory" and pushes its branch **from a factory-owned
 * bare mirror**, not from the agent-writable workspace (SEC-2/SEC-3). The commit is exported as a bundle, ingested with
 * `fsck`/limits (never checked out), and only that push carries the repository token.
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
    const local = async (...args: string[]) => (await execFileP("git", [...GIT_HARDENING, ...args], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

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
      await local("bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
      const exported = await this.ingest.ingest({ bundlePath: bundle, mirrorPath: join(scratch, "mirror.git") });
      // The push runs in the factory-owned mirror: no agent-writable config, and the token reaches only this process.
      await execFileP("git", [...GIT_HARDENING, "push", "--quiet", "--no-verify", url, `${exported.ref}:refs/heads/${branch}`], { cwd: join(scratch, "mirror.git"), env: authEnv, maxBuffer: 16 * 1024 * 1024 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return { branch, commit, pushed: true };
  }
}
