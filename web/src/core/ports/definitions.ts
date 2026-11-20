import type { Resource } from "../model/resource.ts";
import type { DefinitionLoader, Unsubscribe } from "./store.ts";

export interface DefinitionList {
  resources: Resource[];
  resourceVersion: string;
}

/** Origin of definitions (Git checkout, Kubernetes cluster). `watch` is optional: Git feeds never push changes. */
export interface DefinitionFeed {
  list(): Promise<DefinitionList>;
  watch?(sinceResourceVersion: string, onChange: () => void): Unsubscribe;
}

/** A raw custom resource as returned by the Kubernetes API. */
export interface RawCustomResource {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
}

export interface ClusterKindRef {
  group: string;
  version: string;
  plural: string;
}

/** Low-level cluster access, the seam for a fake in tests. */
export interface ClusterApi {
  list(ref: ClusterKindRef): Promise<{ items: RawCustomResource[]; resourceVersion: string }>;
  /** Optional change stream; `onClose` fires when the connection drops or the server answers 410 Gone. */
  watch?(ref: ClusterKindRef, sinceResourceVersion: string, onEvent: () => void, onClose: (err?: Error) => void): Unsubscribe;
}

/** Whole-snapshot check run before a reload is swapped in. Empty = valid. */
export interface SnapshotValidator {
  validate(resources: Resource[]): Promise<string[]>;
}

export type { DefinitionLoader };

/** Reads the Secrets of one namespace (name → key → value). Segregated from `ClusterApi` so RBAC stays namespaced. */
export interface NamespacedSecretReader {
  readSecrets(namespace: string): Promise<Record<string, Record<string, string>>>;
}

/** Change stream for the Secrets of one namespace (ADR-0077). Kept apart from the reader (ISP). */
export interface SecretWatcher {
  watchSecrets(namespace: string, onChange: () => void, onClose: (err?: Error) => void): Unsubscribe;
}
