import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * The process's outbound HTTP dispatcher, set explicitly instead of relying on `NODE_USE_ENV_PROXY`.
 *
 * Node creates its env-proxy dispatcher lazily on the first `fetch`, and only when none exists yet. Importing the npm
 * `undici` package (via `@kubernetes/client-node`, OpenCode's `@effect/platform-node`, …) installs a plain `Agent`
 * first, so whether `fetch` used the proxy depended on module load order. Installing ours up front makes undici's
 * own initialisation a no-op, and `ensureProxyDispatcher` re-asserts it if a later module replaced it.
 */
type Env = Record<string, string | undefined>;

let installed: Dispatcher | undefined;
let installedProxy: string | undefined;

export function proxyUrl(env: Env = process.env): string | undefined {
  const v = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  return v && v.trim() ? v.trim() : undefined;
}

/** Installs (once) the env-proxy dispatcher, or a plain agent without proxy variables. Idempotent; returns the proxy in use. */
export function ensureProxyDispatcher(env: Env = process.env): string | undefined {
  if (!installed) {
    installedProxy = proxyUrl(env);
    installed = installedProxy ? new EnvHttpProxyAgent() : new Agent();
  }
  if (getGlobalDispatcher() !== installed) setGlobalDispatcher(installed);
  return installedProxy;
}

/** False when a proxy is configured but `fetch` would not use our dispatcher (health). */
export function proxyDispatcherActive(env: Env = process.env): boolean {
  if (!proxyUrl(env)) return true;
  return installed !== undefined && getGlobalDispatcher() === installed;
}

/** Proxy description for error messages and logs, with credentials removed. */
export function describeProxy(env: Env = process.env): string {
  const p = proxyUrl(env);
  if (!p) return "direct";
  try {
    const u = new URL(p);
    return `via proxy ${u.protocol}//${u.host}`;
  } catch {
    return "via proxy (unparseable URL)";
  }
}
