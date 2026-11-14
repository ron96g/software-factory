import { ApiException, CustomObjectsApi, KubeConfig, createConfiguration } from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expandHome } from "./config.ts";
import { QueryError, type CustomResourceReader } from "./ports.ts";

const objectSchema = z.object({
  apiVersion: z.string(),
  kind: z.string(),
  metadata: z.object({ name: z.string(), namespace: z.string().optional() }).passthrough(),
  spec: z.unknown().optional(),
  status: z.unknown().optional(),
});
const pageSchema = z.object({
  items: z.array(objectSchema),
  metadata: z.object({ continue: z.string().optional() }).optional(),
});

export function loadKubeConfig(options: { kubeconfig?: string; context?: string }): KubeConfig {
  const config = new KubeConfig();
  try {
    if (options.kubeconfig) config.loadFromFile(expandHome(options.kubeconfig));
    else {
      if (!process.env.KUBECONFIG && !existsSync(join(homedir(), ".kube", "config")) &&
          !existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) throw new Error("No kubeconfig or in-cluster credentials");
      config.loadFromDefault();
    }
    if (options.context) config.setCurrentContext(options.context);
    if (!config.getContextObject(config.getCurrentContext()) || !config.getCurrentCluster()) throw new Error("No current cluster");
  } catch {
    throw new QueryError("Cannot load Kubernetes context; check --kubeconfig / --context and the operator's kubeconfig");
  }
  return config;
}

export function createKubernetesReader(config: KubeConfig): CustomResourceReader {
  const api = config.makeApiClient(CustomObjectsApi);
  const options = {
    middleware: createConfiguration({
      promiseMiddleware: [{
        pre: async (request) => { request.setSignal(AbortSignal.timeout(10_000)); return request; },
        post: async (response) => response,
      }],
    }).middleware,
    middlewareMergeStrategy: "append" as const,
  };
  const request = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiException) throw new QueryError(`Kubernetes read failed (HTTP ${e.code}); check resource, namespace and RBAC`);
      throw new QueryError("Kubernetes read failed; check connectivity, TLS and kubeconfig credentials");
    }
  };
  return {
    async get(type, address) {
      const [group, version] = type.apiVersion.split("/");
      const params = { group, version, plural: type.plural, name: address.name };
      const value = await request(() => type.scope === "Namespaced"
        ? api.getNamespacedCustomObject({ ...params, namespace: address.namespace! }, options)
        : api.getClusterCustomObject(params, options));
      const parsed = objectSchema.safeParse(value);
      if (!parsed.success) throw new QueryError("Kubernetes returned an invalid resource");
      return parsed.data;
    },
    async list(type, query) {
      const [group, version] = type.apiVersion.split("/");
      const params = { group, version, plural: type.plural, labelSelector: query.labelSelector, limit: query.limit, _continue: query.continue, timeoutSeconds: 10 };
      const value = await request(() => type.scope === "Namespaced"
        ? api.listNamespacedCustomObject({ ...params, namespace: query.namespace! }, options)
        : api.listClusterCustomObject(params, options));
      const parsed = pageSchema.safeParse(value);
      if (!parsed.success) throw new QueryError("Kubernetes returned an invalid resource list");
      return { items: parsed.data.items, continue: parsed.data.metadata?.continue || undefined };
    },
  };
}
