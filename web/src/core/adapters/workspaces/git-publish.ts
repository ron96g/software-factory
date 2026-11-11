import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repository, Workspace } from "../../model/kinds.ts";
import type { BranchPublisher, SecretResolver } from "../../ports/index.ts";

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
    const url = repo.spec.git?.url;
    if (!url) throw new Error(`repository ${repo.metadata.name} has no spec.git.url to push to`);
    const token = this.secrets.resolve(repo.spec.git?.secretRef);
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: "0",
      ...(token
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraheader`,
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }
        : {}),
    } as unknown as NodeJS.ProcessEnv;
    const git = async (...args: string[]) => (await execFileP("git", args, { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
    const id = ["-c", "user.name=Software Factory", "-c", "user.email=software-factory@users.noreply.github.com"];

    await git("add", "-A");
    const staged = await git("diff", "--cached", "--name-only");
    if (staged) await git(...id, "commit", "-q", "-m", message);
    const branch = ws.spec.branch;
    await git("push", "--quiet", url, `HEAD:refs/heads/${branch}`);
    return { branch, commit: await git("rev-parse", "HEAD"), pushed: true };
  }
}
