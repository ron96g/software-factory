/** Pure helpers on the resource model (no I/O). */
import type { Condition, ConditionStatus, ObjectKey, OwnerReference, Resource } from "./resource.ts";
import { DEFAULT_NAMESPACE } from "./resource.ts";

export const nsOf = (r: Resource): string => r.metadata.namespace ?? DEFAULT_NAMESPACE;

export const keyString = (namespace: string, name: string): string => `${namespace}/${name}`;

export const keyOf = (r: Resource): string => keyString(nsOf(r), r.metadata.name);

export const parseKey = (key: string): { namespace: string; name: string } => {
  const i = key.indexOf("/");
  return { namespace: key.slice(0, i), name: key.slice(i + 1) };
};

export const objectKey = (r: Resource): ObjectKey => ({ kind: r.kind, name: r.metadata.name, namespace: nsOf(r) });

export const ownerRef = (r: Resource): OwnerReference => ({
  kind: r.kind,
  name: r.metadata.name,
  uid: r.metadata.uid ?? "",
});

export const ownerOf = (r: Resource, kind: string): OwnerReference | undefined =>
  r.metadata.ownerReferences?.find((o) => o.kind === kind);

/** Returns a new conditions array; lastTransitionTime only changes when the status flips. */
export function setCondition(
  conditions: Condition[] | undefined,
  type: string,
  status: ConditionStatus,
  reason: string,
  message: string | undefined,
  now: Date,
): Condition[] {
  const list = [...(conditions ?? [])];
  const i = list.findIndex((c) => c.type === type);
  const prev = i >= 0 ? list[i] : undefined;
  const next: Condition = {
    type,
    status,
    reason,
    message,
    lastTransitionTime: prev && prev.status === status ? prev.lastTransitionTime : now.toISOString(),
  };
  if (i >= 0) list[i] = next;
  else list.push(next);
  return list;
}

export const matchesLabels = (r: Resource, selector?: Record<string, string>): boolean =>
  !selector || Object.entries(selector).every(([k, v]) => r.metadata.labels?.[k] === v);

export const clone = <T>(v: T): T => structuredClone(v);
