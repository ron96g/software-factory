/**
 * Storage ports, segregated by capability (ISP).
 * Consumers depend only on what they use, e.g. the prompt builder takes a `ResourceReader`.
 */
import type { ObjectKey, Resource } from "../model/resource";

export interface ListOptions {
  /** Omitted means all namespaces (cluster-wide list). Authz decorators narrow this later. */
  namespace?: string;
  labelSelector?: Record<string, string>;
  /** Only objects owned by this resource. */
  ownedBy?: ObjectKey;
}

export interface ResourceReader {
  get<R extends Resource = Resource>(kind: string, namespace: string, name: string): Promise<R | null>;
  list<R extends Resource = Resource>(kind: string, options?: ListOptions): Promise<R[]>;
}

/** Writes `metadata` + `spec`. Never touches `status`. */
export interface ResourceWriter {
  create<R extends Resource>(obj: R): Promise<R>;
  update<R extends Resource>(obj: R): Promise<R>;
  delete(kind: string, namespace: string, name: string): Promise<void>;
}

/** Writes `status` only (status subresource). Reserved for controllers. */
export interface StatusWriter {
  updateStatus<R extends Resource>(obj: R): Promise<R>;
}

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED";

export interface WatchEvent<R extends Resource = Resource> {
  type: WatchEventType;
  object: R;
}

export type Unsubscribe = () => void;

export interface ResourceWatcher {
  watch(listener: (event: WatchEvent) => void, kinds?: string[]): Unsubscribe;
}

/** Full store, the composition of all capabilities. Only the composition root sees this. */
export interface ResourceStore extends ResourceReader, ResourceWriter, StatusWriter, ResourceWatcher {}

/** Loads read-only definitions (agents, skills, workflows, …) from some origin, e.g. a Git checkout. */
export interface DefinitionLoader {
  load(): Promise<Resource[]>;
}

/** Selects the backend for a kind (used by a composite store). */
export interface StoreRouter {
  route(kind: string): ResourceStore;
}

// ── Errors (part of the contract) ────────────────────────────────────────

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: "NotFound" | "AlreadyExists" | "Conflict" | "ReadOnly" | "Invalid",
    readonly details?: string[],
  ) {
    super(message);
  }
}
