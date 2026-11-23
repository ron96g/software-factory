import type { ChangeFeed, ResourceReader, ResourceWatcher, Unsubscribe, WatchEvent } from "../ports/index.ts";

export interface FeedWatcherOptions {
  feed: ChangeFeed;
  reader: ResourceReader;
  pollMs?: number;
  onError?: (message: string, err?: unknown) => void;
}

/**
 * ADR-0062 §1: a `ResourceWatcher` fed by the durable change feed instead of an in-process emitter. It polls from its
 * cursor, loads each changed object and delivers the same `WatchEvent`s a local writer would; when its cursor is older
 * than the retained range it re-lists the watched kinds (a full resync). This is what lets a web process see writes made
 * by a worker (and what replaces the in-process emitter once the two processes are split).
 */
export class FeedWatcher implements ResourceWatcher {
  private readonly feed: ChangeFeed;
  private readonly reader: ResourceReader;
  private readonly pollMs: number;
  private readonly onError?: (message: string, err?: unknown) => void;
  private readonly listeners = new Set<{ fn: (e: WatchEvent) => void; kinds?: string[] }>();
  private cursor = 0;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(o: FeedWatcherOptions) {
    this.feed = o.feed;
    this.reader = o.reader;
    this.pollMs = o.pollMs ?? 250;
    this.onError = o.onError;
  }

  watch(listener: (event: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    const entry = { fn: listener, kinds };
    this.listeners.add(entry);
    this.ensurePolling();
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Starts from the current head, so only later changes are delivered (never a replay of history). */
  async start(): Promise<void> {
    this.cursor = await this.feed.head();
    this.ensurePolling();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one poll cycle now (tests and callers that want a deterministic step). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { entries, cursor, resync } = await this.feed.since(this.cursor);
      this.cursor = cursor;
      if (resync) await this.resync();
      for (const e of entries) {
        if (e.type === "DELETED") {
          // The object is gone: deliver a tombstone a consumer can key on and then re-read (and see nothing).
          this.emit({ type: "DELETED", object: { apiVersion: "", kind: e.kind, metadata: { name: e.name, namespace: e.namespace, resourceVersion: e.resourceVersion } } as never });
          continue;
        }
        const obj = await this.reader.get(e.kind, e.namespace, e.name);
        if (obj) this.emit({ type: e.type, object: obj });
      }
    } catch (err) {
      this.onError?.("change feed poll failed", err);
    } finally {
      this.polling = false;
    }
  }

  private ensurePolling(): void {
    if (this.timer || !this.listeners.size) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  /** The cursor fell behind the retention window: re-list every watched kind so consumers re-reconcile. */
  private async resync(): Promise<void> {
    const kinds = new Set([...this.listeners].flatMap((l) => l.kinds ?? []));
    for (const kind of kinds) {
      for (const obj of await this.reader.list(kind)) this.emit({ type: "ADDED", object: obj });
    }
  }

  private emit(event: WatchEvent): void {
    for (const l of this.listeners) {
      if (l.kinds && !l.kinds.includes(event.object.kind)) continue;
      try {
        l.fn(event);
      } catch {
        // a faulty listener must not break the poller
      }
    }
  }
}
