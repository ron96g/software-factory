import type { KindInfo, KindLookup, KindRegistrar, Lookup, Registrar } from "../ports/index.ts";

export class Registry<T> implements Lookup<T>, Registrar<T> {
  private readonly items = new Map<string, T>();
  register(key: string, impl: T): void {
    this.items.set(key, impl);
  }
  get(key: string): T | undefined {
    return this.items.get(key);
  }
  keys(): string[] {
    return [...this.items.keys()];
  }
  values(): T[] {
    return [...this.items.values()];
  }
}

export class KindRegistry implements KindLookup, KindRegistrar {
  private readonly kinds = new Map<string, KindInfo>();
  register(info: KindInfo): void {
    this.kinds.set(info.kind, info);
  }
  byKind(kind: string): KindInfo | undefined {
    return this.kinds.get(kind);
  }
  byPlural(plural: string): KindInfo | undefined {
    return [...this.kinds.values()].find((k) => k.plural === plural);
  }
  all(): KindInfo[] {
    return [...this.kinds.values()];
  }
}
