import type { Resource } from "../model/resource.ts";

export interface ReadyCondition {
  type: "Ready";
  status: "True" | "False";
  reason: string;
  message: string;
  lastTransitionTime: string;
  observedGeneration?: number;
}
/** Port: PUT/PATCH on the /status subresource only. Receives identity + the status body, never spec/metadata. */
export interface StatusPort {
  putStatus(target: { kind: string; namespace: string; name: string }, status: { conditions: ReadyCondition[] }): Promise<void>;
}

/** Writes the Ready condition on the status subresource. Never touches spec or metadata. */
export class StatusWriter {
  private readonly last = new Map<string, string>();
  private readonly port: StatusPort;
  private readonly now: () => string;
  constructor(port: StatusPort, now: () => string = () => new Date().toISOString()) {
    this.port = port;
    this.now = now;
  }
  async writeReady(r: Resource, ready: boolean, reason: string, message = ""): Promise<void> {
    const target = { kind: r.kind, namespace: r.metadata.namespace ?? "default", name: r.metadata.name };
    const key = `${target.kind}/${target.namespace}/${target.name}`;
    const sig = `${ready}|${reason}|${message}`;
    if (this.last.get(key) === sig) return; // avoid status-write -> watch-event loops
    const generation = (r.metadata as { generation?: number }).generation;
    const c: ReadyCondition = { type: "Ready", status: ready ? "True" : "False", reason, message, lastTransitionTime: this.now() };
    if (generation !== undefined) c.observedGeneration = generation;
    try {
      await this.port.putStatus(target, { conditions: [c] });
      this.last.set(key, sig);
    } catch {
      /* status is best effort; never break reload */
    }
  }
  accepted(r: Resource): Promise<void> {
    return this.writeReady(r, true, "Accepted");
  }
  /** Rejected apply or referenced delete: the last good state is kept. */
  rejected(r: Resource, reason: string): Promise<void> {
    return this.writeReady(r, false, "Rejected", reason);
  }
  /** Message carries only the Secret name, never a value. */
  missingSecret(r: Resource, secretName: string): Promise<void> {
    return this.writeReady(r, false, "SecretMissing", `Secret ${secretName} not found`);
  }
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
export function inClusterStatus(env: Record<string, string | undefined> = process.env, plural: (kind: string) => string): StatusPort {
  const base = `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? "443"}`;
  return {
    async putStatus(t, status) {
      const { readFileSync } = await import("node:fs");
      const token = readFileSync(`${SA}/token`, "utf8").trim();
      const res = await fetch(`${base}/apis/factory.ai-dlc.io/v1alpha1/namespaces/${t.namespace}/${plural(t.kind)}/${t.name}/status`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/merge-patch+json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`status ${t.kind}/${t.name}: ${res.status}`);
    },
  };
}
