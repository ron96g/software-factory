import { CoreV1Api, KubeConfig, Watch } from "@kubernetes/client-node";
import type { NamespacedSecretReader, SecretWatcher, Unsubscribe } from "../../ports/index.ts";

/** ADR-0077: lists Secrets of one namespace only (namespaced Role); values stay in memory. */
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

/** ADR-0077: watches Secrets of one namespace only (namespaced Role); events carry no values to callers. */
export class KubeSecretWatcher implements SecretWatcher {
  private readonly watcher: Watch;
  constructor(kc?: KubeConfig) {
    const cfg = kc ?? new KubeConfig();
    if (!kc) cfg.loadFromDefault();
    this.watcher = new Watch(cfg);
  }

  watchSecrets(namespace: string, onChange: () => void, onClose: (err?: Error) => void): Unsubscribe {
    let aborter: AbortController | undefined;
    let stopped = false;
    this.watcher
      .watch(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
        { allowWatchBookmarks: true },
        (phase) => { if (phase !== "BOOKMARK") onChange(); },
        (err) => { if (!stopped) onClose(err ?? undefined); },
      )
      .then((a) => { aborter = a; if (stopped) a.abort(); })
      .catch((e) => { if (!stopped) onClose(e instanceof Error ? e : new Error(String(e))); });
    return () => { stopped = true; aborter?.abort(); };
  }
}
