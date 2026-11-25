import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../model/kinds.ts";
import { CandidateCommitRejectedError, type CandidateCommitter, type CommitHookSetup, type ExecResult } from "../ports/index.ts";
import { runCommitJobs } from "../adapters/sandbox/candidate-commit.ts";
import { scrubbedEnv } from "../adapters/sandbox/process.ts";

const execFileP = promisify(execFile);

/**
 * Test helper: runs the ADR-0092 commit job **without** a sandbox, so suites cover the git behaviour on machines without
 * `bwrap`. Never wired in the composition root (rule 18).
 */
export class HostCandidateCommitter implements CandidateCommitter {
  private readonly hooks: Record<string, CommitHookSetup>;
  constructor(hooks: CommitHookSetup[] = []) {
    this.hooks = Object.fromEntries(hooks.map((h) => [h.type, h]));
  }

  async commit(ws: Workspace, repo: Repository, input: { message: string; outDir: string }) {
    const type = repo.spec.git?.commit?.hooks;
    if (type && !this.hooks[type]) throw new CandidateCommitRejectedError(`publication commit rejected: unknown commit hook setup "${type}"`, "");
    const path = ws.status!.path!;
    return runCommitJobs(path, { ...input, branch: ws.spec.branch, hooks: type }, type ? this.hooks[type] : undefined, async (job) => {
      try {
        const { stdout, stderr } = await execFileP("bash", [job.script], { cwd: path, env: { ...scrubbedEnv(), ...job.env } });
        return { exitCode: 0, stdout, stderr, truncated: false, durationMs: 0 } satisfies ExecResult;
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "", truncated: false, durationMs: 0 } satisfies ExecResult;
      }
    });
  }
}
