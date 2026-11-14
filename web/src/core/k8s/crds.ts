import { readFileSync, existsSync } from "node:fs";
import { stringify } from "yaml";
import { BUILTIN_KINDS } from "../registry/kinds.ts";

export const API_GROUP = "factory.ai-dlc.io";
export const API_VERSION = "v1alpha1";
/** Agent and Skill are Markdown documents: their body maps to spec.body in the CR. */
export const BODY_KINDS = ["Agent", "Skill"];
export const DEFINITION_KINDS = ["Agent", "Skill", "Workflow", "ArtifactType", "Source", "Repository", "KnowledgeSource", "ToolServer", "ModelProvider"];

const SCHEMAS = new URL("../../../../schemas/", import.meta.url);
function loadJson(name: string): any | undefined {
  const u = new URL(name, SCHEMAS);
  return existsSync(u) ? JSON.parse(readFileSync(u, "utf8")) : undefined;
}
/** Spec schema derived from schemas/: common spec shape, refined by schemas/<kind>.schema.json when present. */
function specSchema(kind: string): Record<string, unknown> {
  const common = loadJson("common.schema.json");
  const own = loadJson(`${kind.toLowerCase()}.schema.json`);
  const base = { ...(common?.properties?.spec ?? { type: "object" }) } as Record<string, any>;
  const src = own?.properties?.spec ?? {};
  const out: Record<string, any> = { ...base, ...src, type: "object" };
  delete out.$schema; delete out.$id;
  if (own?.properties?.spec === undefined) out["x-kubernetes-preserve-unknown-fields"] = true;
  return out;
}

export function buildCrds() {
  return DEFINITION_KINDS.map((kind) => {
    const info = BUILTIN_KINDS.find((k) => k.kind === kind)!;
    const spec: Record<string, any> = specSchema(kind);
    if (BODY_KINDS.includes(kind)) {
      spec.properties = { ...(spec.properties ?? {}), body: { type: "string", description: "Markdown body (prompt text)" } };
    }
    return {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: `${info.plural}.${API_GROUP}` },
      spec: {
        group: API_GROUP,
        scope: "Namespaced",
        names: { kind, plural: info.plural, singular: kind.toLowerCase(), listKind: `${kind}List` },
        versions: [{
          name: API_VERSION, served: true, storage: true,
          subresources: { status: {} },
          schema: { openAPIV3Schema: { type: "object", required: ["spec"], properties: {
            spec,
            status: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
          } } },
        }],
      },
    };
  });
}

export function buildClusterRole() {
  const plurals = DEFINITION_KINDS.map((k) => BUILTIN_KINDS.find((b) => b.kind === k)!.plural);
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name: "software-factory" },
    rules: [
      { apiGroups: [API_GROUP], resources: plurals, verbs: ["list", "watch"] },
      { apiGroups: [API_GROUP], resources: plurals.map((p) => `${p}/status`), verbs: ["update"] },
      { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
    ],
  };
}

export function renderManifests(): string {
  return [...buildCrds(), buildClusterRole()].map((d) => stringify(d)).join("---\n");
}
