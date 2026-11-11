import type {
  Controller,
  ControllerRegistrar,
  ControllerTrigger,
  InitialKeys,
  Lifecycle,
  ReconcileErrorReporter,
  ResourceWatcher,
  WorkQueue,
} from "../ports/index.ts";

type Registered = Controller & Partial<InitialKeys>;

/** De-duplicating queue: a key is never processed concurrently and is collapsed while pending. */
export class KeyedQueue implements WorkQueue {
  private readonly pending = new Set<string>();
  private readonly active = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly process: (key: string) => Promise<void>;
  private stopped = false;

  constructor(process: (key: string) => Promise<void>) {
    this.process = process;
  }

  add(key: string): void {
    if (this.stopped) return;
    if (this.active.has(key)) {
      this.dirty.add(key);
      return;
    }
    if (this.pending.has(key)) return;
    this.pending.add(key);
    queueMicrotask(() => void this.run(key));
  }

  addAfter(key: string, delayMs: number): void {
    if (delayMs <= 0) return this.add(key);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.add(key);
    }, delayMs);
    this.timers.add(t);
  }

  idle(): boolean {
    return this.pending.size === 0 && this.active.size === 0 && this.timers.size === 0;
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  private async run(key: string): Promise<void> {
    this.pending.delete(key);
    this.active.add(key);
    try {
      await this.process(key);
    } finally {
      this.active.delete(key);
      if (this.dirty.delete(key)) this.add(key);
    }
  }
}

/** Wires controllers to store watch events; requeue with exponential backoff; periodic resync. */
export class ControllerManager implements ControllerRegistrar, ControllerTrigger, Lifecycle {
  private readonly controllers: { c: Registered; q: KeyedQueue; failures: Map<string, number> }[] = [];
  private readonly watcher: ResourceWatcher;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly reporter?: ReconcileErrorReporter;
  private unsubscribe?: () => void;
  private resyncTimers: ReturnType<typeof setInterval>[] = [];

  constructor(watcher: ResourceWatcher, log: (msg: string, err?: unknown) => void = () => {}, reporter?: ReconcileErrorReporter) {
    this.watcher = watcher;
    this.log = log;
    this.reporter = reporter;
  }

  register(c: Registered): void {
    const failures = new Map<string, number>();
    const q: KeyedQueue = new KeyedQueue(async (key) => {
      try {
        const res = await c.reconcile(key);
        if (failures.delete(key)) this.reporter?.recovered(c.name, key);
        if (res && res.requeueAfterMs !== undefined) q.addAfter(key, res.requeueAfterMs);
      } catch (e) {
        const n = (failures.get(key) ?? 0) + 1;
        failures.set(key, n);
        const delay = Math.min(100 * 2 ** n, 60_000);
        this.log(`[${c.name}] reconcile ${key} failed (attempt ${n}), retry in ${delay}ms`, e);
        await this.reporter?.failed({ controller: c.name, kind: c.primaryKind, key, attempt: n, error: e }).catch(() => {});
        q.addAfter(key, delay);
      }
    });
    this.controllers.push({ c, q, failures });
  }

  trigger(controllerName: string, key: string): void {
    this.controllers.find((x) => x.c.name === controllerName)?.q.add(key);
  }

  async start(): Promise<void> {
    this.unsubscribe = this.watcher.watch((event) => {
      for (const { c, q } of this.controllers) {
        if (!c.watches.includes(event.object.kind)) continue;
        for (const key of c.keysFor(event)) q.add(key);
      }
    });
    for (const { c, q } of this.controllers) {
      const enqueueAll = async () => (await c.initialKeys?.())?.forEach((k) => q.add(k));
      await enqueueAll();
      if (c.resyncMs) this.resyncTimers.push(setInterval(() => void enqueueAll(), c.resyncMs));
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.resyncTimers.forEach(clearInterval);
    this.controllers.forEach(({ q }) => q.stop());
  }

  /** Test helper: resolves when all queues are idle. */
  async settle(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
      if (this.controllers.every(({ q }) => q.idle())) {
        await new Promise((r) => setTimeout(r, 20));
        if (this.controllers.every(({ q }) => q.idle())) return;
      }
    }
    throw new Error("controllers did not settle");
  }
}
