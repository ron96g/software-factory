import { readFileSync } from "node:fs";
import type { Ref } from "../model/resource.ts";
import type { SecretResolver } from "../ports/index.ts";

/** Reads one Secret's decoded data; undefined when not found. Needs only `get` on secrets. */
export interface SecretsPort {
  get(namespace: string, name: string): Promise<Record<string, string> | undefined>;
}

export class SecretMissingError extends Error {
  readonly namespace: string;
  readonly secretName: string;
  constructor(namespace: string, name: string) {
    super(`Secret ${namespace}/${name} not found`);
    this.namespace = namespace;
    this.secretName = name;
  }
}

/** Resolves SecretRefs from the cluster at reload time; resolve() is a sync cache read. Values never enter errors. */
export class K8sSecretResolver implements SecretResolver {
  private readonly cache = new Map<string, string>();
  private readonly port: SecretsPort;
  private readonly fallbackNs: string;
  constructor(port: SecretsPort, fallbackNamespace = "factory-system") {
    this.port = port;
    this.fallbackNs = fallbackNamespace;
  }
  /** Fetches only the referenced Secrets. Throws SecretMissingError (no values) if one is absent. */
  async refresh(refs: { ref: Ref | undefined; namespace?: string }[]): Promise<void> {
    const next = new Map<string, string>();
    const seen = new Set<string>();
    for (const { ref, namespace } of refs) {
      if (!ref) continue;
      const ns = ref.namespace ?? namespace ?? this.fallbackNs;
      const id = `${ns}/${ref.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const data = await this.port.get(ns, ref.name);
      if (!data) throw new SecretMissingError(ns, ref.name);
      const v = data.value ?? Object.values(data)[0];
      if (v === undefined) continue;
      next.set(id, v);
      if (!next.has(ref.name)) next.set(ref.name, v);
    }
    this.cache.clear();
    for (const [k, v] of next) this.cache.set(k, v);
  }
  resolve(ref: Ref | undefined): string | undefined {
    if (!ref) return undefined;
    const v = (ref.namespace ? this.cache.get(`${ref.namespace}/${ref.name}`) : undefined) ?? this.cache.get(ref.name);
    return v && v.length > 0 ? v : undefined;
  }
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
export function inClusterSecrets(env: Record<string, string | undefined> = process.env): SecretsPort {
  const base = `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? "443"}`;
  return {
    async get(ns, name) {
      const token = readFileSync(`${SA}/token`, "utf8").trim();
      const res = await fetch(`${base}/api/v1/namespaces/${ns}/secrets/${name}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`get secret ${ns}/${name}: ${res.status}`);
      const j = (await res.json()) as { data?: Record<string, string> };
      return Object.fromEntries(Object.entries(j.data ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]));
    },
  };
}
