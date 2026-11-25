import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { BranchPublisher, CandidateCommitter, ExportIngestor, SecretResolver } from "../../ports/index.ts";
import { GitBundleIngest } from "./git-export.ts";
import { GIT_HARDENING, gitRemote } from "./git-auth.ts";

const execFileP = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * ADR-0023 / ADR-0080 §13 / ADR-0092: publishes a workspace without running git in it. The commit is made **in the
 * sandbox** (`CandidateCommitter`: read-only workspace, private git directory, the repository's hooks when it opts in)
 * and handed over as a bundle; the factory ingests it into a bare mirror (`fsck`, limits, never checked out) and pushes
 * from there. Only the push carries the repository token (SEC-2/SEC-3).
 *
 * ADR-0091: the factory owns its `factory/*` branch, so a moved remote head (e.g. a human's "Update branch" merge on
 * the pull request) must not block publication. The push replaces the branch with a **compare-and-swap lease**: it is
 * forced against the head read just before the push, and fails only if the branch moved again in between (the delivery
 * then retries). The factory never integrates foreign commits into the candidate; the base is reconciled through
 * ADR-0053, and the workspace stays the single source of truth for the branch.
 */
export class GitBranchPublisher implements BranchPublisher {
  private readonly secrets: SecretResolver;
  private readonly committer: CandidateCommitter;
  private readonly ingest: ExportIngestor;
  constructor(secrets: SecretResolver, committer: CandidateCommitter, ingest: ExportIngestor = new GitBundleIngest()) {
    this.secrets = secrets;
    this.committer = committer;
    this.ingest = ingest;
  }

  async publish(ws: Workspace, repo: Repository, message: string) {
    if (!ws.status?.path) throw new Error(`workspace ${ws.metadata.name} has no path`);
    const { url, authEnv } = gitRemote(repo, this.secrets);
    const branch = ws.spec.branch;
    const scratch = await mkdtemp(join(tmpdir(), "factory-publish-"));
    try {
      const out = join(scratch, "job");
      await mkdir(out);
      const made = await this.committer.commit(ws, repo, { message, outDir: out });
      const mirror = join(scratch, "mirror.git");
      const exported = await this.ingest.ingest({ bundlePath: made.bundlePath, mirrorPath: mirror, ref: made.ref });
      // The job's report is untrusted; the ingested objects are what gets pushed, and they must be what it reported.
      if (exported.commit !== made.commit) throw new Error(`the commit job reported ${made.commit} but its bundle carries ${exported.commit}`);
      // Read the head to replace, then push with the lease. The push runs in the factory-owned mirror: no agent-writable
      // config, and the token reaches only this process.
      const remote = await this.remoteHead(mirror, url, branch, authEnv);
      // The job commits anew on every delivery (new timestamp); an unchanged candidate keeps the published commit, so a
      // retry or "Update pull request" does not force-push an identical tree and re-trigger CI.
      if (remote && await this.sameCandidate(mirror, url, branch, remote, exported.commit, authEnv)) return { branch, commit: remote, pushed: false };
      await execFileP("git", [...GIT_HARDENING, "push", "--quiet", "--no-verify",
        `--force-with-lease=refs/heads/${branch}:${remote}`, url, `${exported.ref}:refs/heads/${branch}`],
        { cwd: mirror, env: authEnv, maxBuffer: MAX_BUFFER });
      return { branch, commit: exported.commit, pushed: true };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** True when the published head has the candidate's tree and parents (only its timestamp differs). */
  private async sameCandidate(mirror: string, url: string, branch: string, remote: string, candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const git = async (...args: string[]) => (await execFileP("git", [...GIT_HARDENING, ...args], { cwd: mirror, env, maxBuffer: MAX_BUFFER })).stdout.trim();
    try {
      await git("fetch", "--quiet", "--no-tags", url, `+refs/heads/${branch}:refs/factory/published`);
      if (await git("rev-parse", "refs/factory/published") !== remote) return false;
      const shape = async (c: string) => `${await git("rev-parse", `${c}^{tree}`)} ${await git("rev-parse", `${c}^@`)}`;
      return await shape(remote) === await shape(candidate);
    } catch {
      return false; // unknown: push, as before
    }
  }

  /** The remote head of `branch`, or "" when it does not exist yet (the lease then requires it to still not exist). */
  private async remoteHead(cwd: string, url: string, branch: string, env: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileP("git", [...GIT_HARDENING, "ls-remote", "--heads", url, `refs/heads/${branch}`], { cwd, env, maxBuffer: MAX_BUFFER });
    return stdout.trim().split(/\s+/)[0] ?? "";
  }
}
