import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { NamespacedSecretReader } from "../../ports/index.ts";

/** ADR-0071: lists Secrets of one namespace only (namespaced Role); values stay in memory. */
export class KubeSecretReader implements NamespacedSecretReader {
  private readonly api: CoreV1Api;
  constructor(api?: CoreV1Api) {
    if (api) this.api = api;
    else {
      const kc = new KubeConfig();
      kc.loadFromDefault();
      this.api = kc.makeApiClient(CoreV1Api);
    }
  }

  async readSecrets(namespace: string): Promise<Record<string, Record<string, string>>> {
    const list = await this.api.listNamespacedSecret({ namespace });
    const out: Record<string, Record<string, string>> = {};
    for (const s of list.items) {
      const name = s.metadata?.name;
      if (!name) continue;
      out[name] = Object.fromEntries(
        Object.entries(s.data ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]),
      );
    }
    return out;
  }
}
