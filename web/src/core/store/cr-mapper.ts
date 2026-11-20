import { SYSTEM_NAMESPACE, type Resource } from "../model/resource.ts";
import type { ClusterKindRef, RawCustomResource } from "../ports/index.ts";

export const CRD_GROUP = "factory.ai-dlc.io";
export const CRD_VERSION = "v1alpha1";

/** Definition kinds backed by CRDs, with their plural; Markdown kinds carry `spec.body`. */
export const DEFINITION_CRDS: Record<string, { plural: string; document: boolean }> = {
  Agent: { plural: "agents", document: true },
  Skill: { plural: "skills", document: true },
  Workflow: { plural: "workflows", document: false },
  ArtifactType: { plural: "artifacttypes", document: false },
  Source: { plural: "sources", document: false },
  Repository: { plural: "repositories", document: false },
  ModelProvider: { plural: "modelproviders", document: false },
  SandboxProfile: { plural: "sandboxprofiles", document: false },
  KnowledgeSource: { plural: "knowledgesources", document: false },
  ToolServer: { plural: "toolservers", document: false },
};

export function crdRef(kind: string): ClusterKindRef {
  const c = DEFINITION_CRDS[kind];
  if (!c) throw new Error(`no CRD registered for kind ${kind}`);
  return { group: CRD_GROUP, version: CRD_VERSION, plural: c.plural };
}

/** Maps a cluster namespace to a factory namespace; unmapped namespaces are kept as is. */
export type NamespaceMap = Record<string, string>;

export function toResource(kind: string, cr: RawCustomResource, namespaces: NamespaceMap = {}): Resource {
  const c = DEFINITION_CRDS[kind];
  if (!c) throw new Error(`no CRD registered for kind ${kind}`);
  const m = cr.metadata;
  const spec = { ...(cr.spec ?? {}) };
  const metadata: Resource["metadata"] = {
    name: m.name,
    namespace: m.namespace ? (namespaces[m.namespace] ?? m.namespace) : SYSTEM_NAMESPACE,
    ...(m.uid ? { uid: m.uid } : {}),
    ...(m.resourceVersion ? { resourceVersion: m.resourceVersion } : {}),
    ...(m.labels ? { labels: { ...m.labels } } : {}),
    ...(m.annotations ? { annotations: { ...m.annotations } } : {}),
  };
  const out: Record<string, unknown> = { apiVersion: cr.apiVersion ?? `${CRD_GROUP}/${CRD_VERSION}`, kind, metadata };
  if (c.document) {
    out.body = typeof spec.body === "string" ? spec.body.trim() : "";
    delete spec.body;
  }
  out.spec = spec;
  return out as unknown as Resource;
}
