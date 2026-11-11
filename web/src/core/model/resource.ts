/**
 * Resource model (KRM-style). Shared by definitions (Git) and runtime objects (DB).
 * Pure types, no behaviour.
 */

export const API_GROUP = "factory.ai-dlc.io";
export const API_VERSION = `${API_GROUP}/v1alpha1`;

/** Namespaces (ADR-0011). The MVP uses only these two. */
export const SYSTEM_NAMESPACE = "factory-system";
export const DEFAULT_NAMESPACE = "default";

export interface Ref {
  name: string;
  /** Only `factory-system` may be referenced explicitly. Omitted means same namespace, falling back to system. */
  namespace?: string;
}

export interface OwnerReference {
  kind: string;
  name: string;
  uid: string;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  generateName?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
}

export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime: string;
}

export interface Resource<Spec = unknown, Status = unknown> {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  spec: Spec;
  status?: Status;
}

/** Definitions authored as Markdown carry their body (the prompt text). */
export interface DocumentResource<Spec = unknown> extends Resource<Spec> {
  body: string;
}

/** Identity of a resource, used for keys, events and owner lookups. */
export interface ObjectKey {
  kind: string;
  name: string;
  namespace: string;
}
