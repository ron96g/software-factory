import type { Repository } from "../../model/kinds.ts";
import type { SecretResolver } from "../../ports/index.ts";

/**
 * What git needs from the factory's environment to reach a remote: proxy and CA settings. Nothing else is passed, so
 * factory secrets never reach git or its hooks.
 */
const NETWORK_ENV = ["http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR"];

/**
 * SEC-2 (P0-2): a git command whose `cwd` is an agent-writable workspace must not run the repository's own
 * configuration. Hooks, the pager/editor and fsmonitor are disabled; `GIT_HARDENING_ENV` neutralizes the global/system
 * config and the system attributes. Repository-local `filter.*`/`diff.*` drivers can still be configured — the honest
 * note in `docs/security.md` — and are closed only by building the commit in a factory-owned clone (S1).
 */
export const GIT_HARDENING: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.editor=false"];

export const GIT_HARDENING_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** A scrubbed environment for a git command that does not touch a remote (no credential, no factory secrets). */
export function gitLocalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: base.PATH, HOME: base.HOME, ...GIT_HARDENING_ENV } as unknown as NodeJS.ProcessEnv;
}

/**
 * Remote git URL plus the environments a factory git command needs. `env` carries **no credential** and is used for
 * local operations (`add`, `commit`, `diff`); `authEnv` adds the repository token and is used **only** for `fetch` and
 * `push`. Scoping it this way means a repository-local filter or helper, which `git add`/`diff` can run, never inherits
 * the token (SEC-3). `file://` is accepted for local remotes.
 */
export function gitRemote(repo: Repository, secrets: SecretResolver, base: NodeJS.ProcessEnv = process.env): { url: string; env: NodeJS.ProcessEnv; authEnv: NodeJS.ProcessEnv } {
  const url = repo.spec.git?.url;
  if (!url) throw new Error(`repository ${repo.metadata.name} has no spec.git.url`);
  if (!/^(https?|file):\/\//.test(url)) throw new Error(`repository ${repo.metadata.name}: only https git URLs are supported (got ${url})`);
  const token = url.startsWith("file:") ? undefined : secrets.resolve(repo.spec.git?.secretRef);
  const env = {
    ...Object.fromEntries(NETWORK_ENV.filter((key) => base[key]).map((key) => [key, base[key]])),
    PATH: base.PATH,
    HOME: base.HOME,
    ...GIT_HARDENING_ENV,
  } as unknown as NodeJS.ProcessEnv;
  // GIT_CONFIG_PARAMETERS (not GIT_CONFIG_COUNT, git ≥ 2.31) so the header also reaches older gits.
  const authEnv = token
    ? { ...env, GIT_CONFIG_PARAMETERS: `'http.${new URL(url).origin}/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}'` }
    : env;
  return { url, env, authEnv };
}

export const FACTORY_GIT_IDENTITY = ["-c", "user.name=Software Factory", "-c", "user.email=software-factory@users.noreply.github.com"];
