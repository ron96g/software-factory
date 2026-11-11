import type { Resource } from "../model/resource.ts";
import {
  StoreError,
  type AdmissionContext,
  type AdmissionRegistrar,
  type Admitter,
  type ListOptions,
  type Mutator,
  type ResourceReader,
  type ResourceStore,
  type Unsubscribe,
  type Validator,
  type WatchEvent,
} from "../ports/index.ts";

export class AdmissionChain implements Admitter, AdmissionRegistrar {
  private readonly mutators: Mutator[] = [];
  private readonly validators: Validator[] = [];
  addMutator(m: Mutator): void {
    this.mutators.push(m);
  }
  addValidator(v: Validator): void {
    this.validators.push(v);
  }
  async admit(input: Resource, ctx: AdmissionContext): Promise<Resource> {
    let obj = input;
    for (const m of this.mutators) if (m.appliesTo(obj.kind)) obj = await m.mutate(obj, ctx);
    const problems: string[] = [];
    for (const v of this.validators) if (v.appliesTo(obj.kind)) problems.push(...(await v.validate(obj, ctx)));
    if (problems.length) {
      throw new StoreError(`${obj.kind} ${obj.metadata.name ?? ""} rejected: ${problems.join("; ")}`, "Invalid", problems);
    }
    return obj;
  }
}

/** Decorator: spec writes (create/update) pass admission; status writes don't (controllers own status). */
export class AdmittedStore implements ResourceStore {
  private readonly inner: ResourceStore;
  private readonly admitter: Admitter;
  private readonly reader: ResourceReader;
  constructor(inner: ResourceStore, admitter: Admitter, reader?: ResourceReader) {
    this.inner = inner;
    this.admitter = admitter;
    this.reader = reader ?? inner;
  }
  get<R extends Resource = Resource>(kind: string, namespace: string, name: string) {
    return this.inner.get<R>(kind, namespace, name);
  }
  list<R extends Resource = Resource>(kind: string, o?: ListOptions) {
    return this.inner.list<R>(kind, o);
  }
  async create<R extends Resource>(obj: R): Promise<R> {
    const admitted = await this.admitter.admit(obj, { operation: "CREATE", reader: this.reader });
    return this.inner.create(admitted as R);
  }
  async update<R extends Resource>(obj: R): Promise<R> {
    const old = await this.inner.get(obj.kind, obj.metadata.namespace ?? "default", obj.metadata.name);
    const admitted = await this.admitter.admit(obj, { operation: "UPDATE", oldObject: old ?? undefined, reader: this.reader });
    return this.inner.update(admitted as R);
  }
  updateStatus<R extends Resource>(obj: R) {
    return this.inner.updateStatus(obj);
  }
  delete(kind: string, namespace: string, name: string) {
    return this.inner.delete(kind, namespace, name);
  }
  watch(l: (e: WatchEvent) => void, kinds?: string[]): Unsubscribe {
    return this.inner.watch(l, kinds);
  }
}
