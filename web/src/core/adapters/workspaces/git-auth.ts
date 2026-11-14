import type { Repository } from "../../model/kinds.ts";
import type { SecretResolver } from "../../ports/index.ts";

/**
 * Remote git URL plus an environment that authenticates through git's config environment
 * (never on the command line, never in the remote URL). `file://` is accepted for local remotes.
 */
export function gitRemote(repo: Repository, secrets: SecretResolver): { url: string; env: NodeJS.ProcessEnv } {
  const url = repo.spec.git?.url;
  if (!url) throw new Error(`repository ${repo.metadata.name} has no spec.git.url`);
  if (!/^(https?|file):\/\//.test(url)) throw new Error(`repository ${repo.metadata.name}: only https git URLs are supported (got ${url})`);
  const token = url.startsWith("file:") ? undefined : secrets.resolve(repo.spec.git?.secretRef);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    // GIT_CONFIG_PARAMETERS (not GIT_CONFIG_COUNT, git ≥ 2.31) so the header also reaches older gits.
    ...(token
      ? { GIT_CONFIG_PARAMETERS: `'http.${new URL(url).origin}/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}'` }
      : {}),
  } as unknown as NodeJS.ProcessEnv;
  return { url, env };
}

export const FACTORY_GIT_IDENTITY = ["-c", "user.name=Software Factory", "-c", "user.email=software-factory@users.noreply.github.com"];
