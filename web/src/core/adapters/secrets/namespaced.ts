import type { Ref } from "../../model/resource.ts";
import type { NamespacedSecretReader, SecretResolver, SecretWatcher, Unsubscribe } from "../../ports/index.ts";

export interface SecretRotationOptions {
  watcher?: SecretWatcher;
  /** Periodic re-list as a fallback for missed watch events. Default 5 min. */
  relistMs?: number;
  /** Delay before re-opening a closed watch. Default 5 s. */
  rewatchMs?: number;
  /** Receives only Secret names/counts, never values. */
  log?: (msg: string, err?: unknown) => void;
}

/** ADR-0077: serves secretRefs from an in-memory copy of exactly one namespace; refs naming another namespace are refused. */
export class NamespacedSecretResolver implements SecretResolver {
  private cache: Record<string, Record<string, string>> = {};
  private readonly reader: NamespacedSecretReader;
  readonly namespace: string;
  private timer?: ReturnType<typeof setInterval>;
  private rewatch?: ReturnType<typeof setTimeout>;
  private unwatch?: Unsubscribe;
  private stopped = true;
  constructor(reader: NamespacedSecretReader, namespace: string) {
    this.reader = reader;
    this.namespace = namespace;
  }

  /** Swaps the whole cache in one assignment so readers never see a half-updated set. */
  async refresh(): Promise<string[]> {
    const next = await this.reader.readSecrets(this.namespace);
    this.cache = next;
    return Object.keys(next).sort();
  }

  /** Keeps the cache current: refresh on every watch event and watch close, plus a periodic re-list. */
  start(o: SecretRotationOptions = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    const refresh = (why: string) => {
      if (this.stopped) return;
      this.refresh()
        .then((names) => o.log?.(`secrets refreshed (${why}): ${names.length} in ${this.namespace}: ${names.join(", ")}`))
        .catch((err) => o.log?.(`secret refresh (${why}) failed`, err));
    };
    const watch = () => {
      if (this.stopped || !o.watcher) return;
      this.unwatch = o.watcher.watchSecrets(this.namespace, () => refresh("watch"), (err) => {
        this.unwatch = undefined;
        if (this.stopped) return;
        if (err) o.log?.("secret watch closed", err);
        refresh("watch closed");
        this.rewatch = setTimeout(watch, o.rewatchMs ?? 5000);
      });
    };
    watch();
    this.timer = setInterval(() => refresh("relist"), o.relistMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.rewatch) clearTimeout(this.rewatch);
    this.unwatch?.();
    this.timer = this.rewatch = this.unwatch = undefined;
  }

  resolve(ref: Ref | undefined): string | undefined {
    if (!ref) return undefined;
    const ns = (ref as Ref & { namespace?: string }).namespace;
    if (ns !== undefined && ns !== this.namespace) return undefined;
    const data = this.cache[ref.name];
    if (!data) return undefined;
    const v = data.value ?? (Object.keys(data).length === 1 ? Object.values(data)[0] : undefined);
    return v && v.length > 0 ? v : undefined;
  }
}
