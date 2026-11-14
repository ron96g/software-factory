import { readFileSync } from "node:fs";
import type { Resource } from "../model/resource.ts";
import { GoneError, type RestPort, type WatchMsg } from "./loader.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const GROUP = "factory.ai-dlc.io/v1alpha1";
const PLURALS = ["agents", "skills", "workflows", "artifacttypes", "sources", "repositories", "knowledgesources", "toolservers", "modelproviders"];

/** In-cluster REST port over fetch, one list/watch per CRD across all namespaces. */
export function inClusterRest(env: Record<string, string | undefined> = process.env): RestPort {
  const base = `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? "443"}`;
  const headers = () => ({ authorization: `Bearer ${readFileSync(`${SA}/token`, "utf8").trim()}` });
  const url = (p: string, q = "") => `${base}/apis/${GROUP}/${p}${q}`;
  return {
    async list() {
      const items: Resource[] = [];
      const rvs: Record<string, string> = {};
      for (const p of PLURALS) {
        const res = await fetch(url(p), { headers: headers() });
        if (!res.ok) throw new Error(`list ${p}: ${res.status}`);
        const j = (await res.json()) as { items: Resource[]; metadata?: { resourceVersion?: string } };
        for (const i of j.items) items.push({ ...i, apiVersion: GROUP });
        rvs[p] = j.metadata?.resourceVersion ?? "";
      }
      return { items, resourceVersion: JSON.stringify(rvs) };
    },
    async *watch(rv, signal) {
      // One watch per kind, each with its own resourceVersion; streams are merged.
      const rvs = JSON.parse(rv) as Record<string, string>;
      const queue: WatchMsg[] = [];
      let err: unknown;
      let wake: (() => void) | undefined;
      const push = () => { wake?.(); wake = undefined; };
      const ac = new AbortController();
      signal?.addEventListener("abort", () => ac.abort());
      const run = async (p: string) => {
        try {
          for await (const m of watchKind(p, rvs[p] ?? "", ac.signal)) { queue.push(m); push(); }
        } catch (e) { err ??= e; ac.abort(); push(); }
      };
      const all = Promise.all(PLURALS.map(run)).then(push);
      try {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (err) throw err;
          if (ac.signal.aborted) return;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally { ac.abort(); await all.catch(() => {}); }
    },
  };
  async function* watchKind(p: string, rv: string, signal: AbortSignal): AsyncGenerator<WatchMsg> {
      const res = await fetch(url(p, `?watch=1&resourceVersion=${rv}`), { headers: headers(), signal });
      if (res.status === 410) throw new GoneError();
      if (!res.ok || !res.body) throw new Error(`watch: ${res.status}`);
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += Buffer.from(chunk).toString("utf8");
        let n;
        while ((n = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, n).trim();
          buf = buf.slice(n + 1);
          if (!line) continue;
          const m = JSON.parse(line) as WatchMsg & { object: { code?: number } };
          if (m.type === ("ERROR" as string) && m.object.code === 410) throw new GoneError();
          yield m;
        }
      }
  }
}
