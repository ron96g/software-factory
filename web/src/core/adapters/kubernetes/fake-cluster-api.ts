import type { Unsubscribe, ClusterApi, ClusterKindRef, RawCustomResource } from "../../ports/index.ts";

export class FakeClusterApi implements ClusterApi {
  private readonly byPlural = new Map<string, RawCustomResource[]>();
  private rv = 1;
  failWith?: Error;
  set(plural: string, items: RawCustomResource[]): void {
    this.byPlural.set(plural, items);
    this.rv++;
  }
  async list(ref: ClusterKindRef) {
    if (this.failWith) throw this.failWith;
    return { items: [...(this.byPlural.get(ref.plural) ?? [])], resourceVersion: String(this.rv) };
  }
  private readonly watchers = new Map<string, Array<{ onEvent: () => void; onClose: (e?: Error) => void }>>();
  watchStarts: Array<{ plural: string; since: string }> = [];
  watch(ref: ClusterKindRef, since: string, onEvent: () => void, onClose: (e?: Error) => void): Unsubscribe {
    const w = { onEvent, onClose };
    this.watchStarts.push({ plural: ref.plural, since });
    this.watchers.set(ref.plural, [...(this.watchers.get(ref.plural) ?? []), w]);
    return () => this.watchers.set(ref.plural, (this.watchers.get(ref.plural) ?? []).filter((x) => x !== w));
  }
  /** Changes the items and notifies watchers. */
  change(plural: string, items: RawCustomResource[]): void {
    this.set(plural, items);
    for (const w of this.watchers.get(plural) ?? []) w.onEvent();
  }
  /** Simulates a dropped connection / 410 Gone. */
  drop(plural: string, err = new Error("410 Gone")): void {
    const ws = this.watchers.get(plural) ?? [];
    this.watchers.set(plural, []);
    for (const w of ws) w.onClose(err);
  }
}
