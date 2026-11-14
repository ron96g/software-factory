import type { Resource } from "../model/resource.ts";
import type { DefinitionLoader } from "../ports/index.ts";

export interface WatchMsg {
  type: "ADDED" | "MODIFIED" | "DELETED";
  object: Resource;
}
/** Thrown by a RestPort when the API answers 410 Gone (resourceVersion too old). */
export class GoneError extends Error {
  constructor() {
    super("410 Gone");
  }
}
/** Fakeable REST port to the Kubernetes API (all namespaces). */
export interface RestPort {
  list(): Promise<{ items: Resource[]; resourceVersion: string }>;
  /** Yields events after resourceVersion; ends when the connection drops; throws GoneError on 410. */
  watch(resourceVersion: string, signal: AbortSignal): AsyncIterable<WatchMsg>;
}
export interface LoaderSink {
  apply(def: Resource): Promise<{ ok: boolean; reason?: string }>;
  remove(kind: string, namespace: string, name: string): Promise<{ ok: boolean; reason?: string }>;
}
export interface K8sLoaderOptions {
  backoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onReject?: (r: Resource, reason: string) => void;
  onAccept?: (r: Resource) => void;
  onResync?: () => void;
}

/** Lists definition CRs (bulk initial load) then watches and feeds a store sink; reconnects with backoff, relists on 410. */
export class K8sLoader implements DefinitionLoader {
  private rv = "";
  private readonly ctl = new AbortController();
  private running?: Promise<void>;
  private readonly o: K8sLoaderOptions;
  private readonly rest: RestPort;
  constructor(rest: RestPort, o: K8sLoaderOptions = {}) {
    this.rest = rest;
    this.o = o;
  }

  async load(): Promise<Resource[]> {
    const l = await this.rest.list();
    this.rv = l.resourceVersion;
    for (const r of l.items) this.track(r, false);
    return l.items;
  }

  /** Start watching; sink typically is the DefinitionStore. */
  start(sink: LoaderSink): void {
    this.running ??= this.loop(sink);
  }
  async stop(): Promise<void> {
    this.ctl.abort();
    await this.running;
  }

  private async loop(sink: LoaderSink): Promise<void> {
    const base = this.o.backoffMs ?? 500;
    const max = this.o.maxBackoffMs ?? 30000;
    const sleep = this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    let delay = base;
    while (!this.ctl.signal.aborted) {
      try {
        for await (const m of this.rest.watch(this.rv, this.ctl.signal)) {
          delay = base;
          const rv = m.object.metadata.resourceVersion;
          const ns = m.object.metadata.namespace ?? "default";
          const res =
            m.type === "DELETED"
              ? await sink.remove(m.object.kind, ns, m.object.metadata.name)
              : await sink.apply(m.object);
          if (!res.ok) this.o.onReject?.(m.object, res.reason ?? "rejected");
          else {
            this.track(m.object, m.type === "DELETED");
            if (m.type !== "DELETED") this.o.onAccept?.(m.object);
          }
          if (rv) this.rv = String(rv);
        }
      } catch (e) {
        if (this.ctl.signal.aborted) return;
        if (e instanceof GoneError) {
          try {
            await this.resync(sink);
            delay = base;
            continue;
          } catch {
            /* fall through to backoff */
          }
        }
      }
      if (this.ctl.signal.aborted) return;
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }

  /** Relist and converge: upsert everything listed, remove what disappeared. */
  private async resync(sink: LoaderSink): Promise<void> {
    const l = await this.rest.list();
    const id = (r: Resource) => `${r.kind}/${r.metadata.namespace ?? "default"}/${r.metadata.name}`;
    const seen = new Set(l.items.map(id));
    for (const r of l.items) {
      const res = await sink.apply(r);
      if (!res.ok) this.o.onReject?.(r, res.reason ?? "rejected");
      else {
        this.track(r, false);
        this.o.onAccept?.(r);
      }
    }
    for (const [k, g] of [...this.known]) {
      if (seen.has(k)) continue;
      const rr = await sink.remove(g.kind, g.ns, g.name);
      if (rr.ok) this.known.delete(k);
      else
        this.o.onReject?.(
          { kind: g.kind, metadata: { name: g.name, namespace: g.ns } } as unknown as Resource,
          rr.reason ?? "delete rejected",
        );
    }
    this.rv = l.resourceVersion;
    this.o.onResync?.();
  }
  private readonly known = new Map<string, { kind: string; ns: string; name: string }>();
  private track(r: Resource, del: boolean): void {
    const ns = r.metadata.namespace ?? "default";
    const k = `${r.kind}/${ns}/${r.metadata.name}`;
    if (del) this.known.delete(k);
    else this.known.set(k, { kind: r.kind, ns, name: r.metadata.name });
  }
}
