/**
 * Kind registry and admission chain.
 * New kinds plug in by registering a `KindInfo` plus any mutators/validators.
 */
import type { Resource } from "../model/resource.ts";
import type { ResourceReader } from "./store.ts";

export type KindScope = "definition" | "runtime";

export interface KindInfo {
  kind: string;
  /** URL segment, e.g. "workitems". */
  plural: string;
  scope: KindScope;
  description?: string;
}

export interface KindLookup {
  byKind(kind: string): KindInfo | undefined;
  byPlural(plural: string): KindInfo | undefined;
  all(): KindInfo[];
}

export interface KindRegistrar {
  register(info: KindInfo): void;
}

export type AdmissionOperation = "CREATE" | "UPDATE";

export interface AdmissionContext {
  operation: AdmissionOperation;
  /** Previous object on UPDATE. */
  oldObject?: Resource;
  /** Read-only access for resolving references and defaults. */
  reader: ResourceReader;
}

/** Defaulting step. Returns the (possibly) modified object. */
export interface Mutator {
  readonly name: string;
  appliesTo(kind: string): boolean;
  mutate(obj: Resource, ctx: AdmissionContext): Promise<Resource>;
}

/** Validation step. Returns a list of human-readable problems (empty = valid). */
export interface Validator {
  readonly name: string;
  appliesTo(kind: string): boolean;
  validate(obj: Resource, ctx: AdmissionContext): Promise<string[]>;
}

export interface AdmissionRegistrar {
  addMutator(m: Mutator): void;
  addValidator(v: Validator): void;
}

/** Runs all mutators, then all validators. Throws `StoreError("Invalid")` on problems. */
export interface Admitter {
  admit(obj: Resource, ctx: AdmissionContext): Promise<Resource>;
}
