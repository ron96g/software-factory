import type { DefinitionLoader } from "../ports/index.ts";
import { K8sLoader, type K8sLoaderOptions, type RestPort } from "./loader.ts";

/** In-cluster (KUBERNETES_SERVICE_HOST set) CRs are the only source; otherwise the Git loader is used unchanged. */
export function selectDefinitionLoader(
  env: Record<string, string | undefined>,
  git: () => DefinitionLoader,
  rest: () => RestPort,
  opts?: K8sLoaderOptions,
): DefinitionLoader {
  return env.KUBERNETES_SERVICE_HOST ? new K8sLoader(rest(), opts) : git();
}
