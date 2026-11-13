import { addressSchema, listSchema, nameSchema, namespaceSchema } from "./config.ts";
import {
  QueryError, type Catalog, type CrQueries, type CustomResourceReader, type Hierarchy,
  type ListQuery, type ResourceAddress, type ResourceDefinition, type ResourceObject, type ResourceType,
} from "./ports.ts";

const MAX_NODES = 25;
const MAX_REFERENCES = 100;
const sensitiveKey = /secret|password|token|credential|private[-_]?key|api[-_]?key|authorization/i;
const typeKey = (r: ResourceType) => `${r.apiVersion}/${r.kind}`;
const addressKey = (r: ResourceAddress) => `${typeKey(r)}/${r.namespace ?? ""}/${r.name}`;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function valuesAt(value: unknown, segments: string[]): unknown[] {
  if (!segments.length) return value === undefined || value === null ? [] : [value];
  const [head, ...tail] = segments;
  if (head === "*") return Array.isArray(value) ? value.slice(0, MAX_REFERENCES + 1).flatMap((v) => valuesAt(v, tail)) : [];
  return record(value) ? valuesAt(value[head], tail) : [];
}

function sanitize(resource: ResourceObject, definition: ResourceDefinition): ResourceObject {
  const paths = definition.redactPaths.map((p) => p.split("."));
  const scrub = (v: unknown, path: string[]): unknown => {
    if (paths.some((p) => p.length === path.length && p.every((s, i) => s === "*" || s === path[i]))) return "[REDACTED]";
    if (Array.isArray(v)) return v.map((item, i) => scrub(item, [...path, String(i)]));
    if (!record(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, value]) => [
      k, sensitiveKey.test(k) ? "[REDACTED]" : scrub(value, [...path, k]),
    ]));
  };
  const metadataKeys = ["name", "namespace", "uid", "resourceVersion", "generation", "creationTimestamp", "labels", "ownerReferences", "deletionTimestamp"];
  const metadata = Object.fromEntries(metadataKeys.filter((k) => resource.metadata[k] !== undefined).map((k) => [k, scrub(resource.metadata[k], ["metadata", k])]));
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    // Keep address fields typed; annotations and managedFields never leave the server.
    metadata: { ...metadata, name: resource.metadata.name, namespace: resource.metadata.namespace },
    spec: scrub(resource.spec, ["spec"]),
    status: scrub(resource.status, ["status"]),
  };
}

function hierarchySummary(resource: ResourceObject): ResourceObject {
  const status = record(resource.status) ? resource.status : {};
  const conditions = Array.isArray(status.conditions) ? status.conditions.filter(record).map((c) => ({
    type: c.type, status: c.status, reason: c.reason, observedGeneration: c.observedGeneration,
  })) : undefined;
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
      resourceVersion: resource.metadata.resourceVersion,
      generation: resource.metadata.generation,
    },
    status: { phase: status.phase, conditions },
  };
}

export function createCrQueries(catalog: Catalog, reader: CustomResourceReader): CrQueries {
  const definitions = new Map(catalog.resources.map((r) => [typeKey(r), r]));
  const resolveType = (query: ResourceType & { namespace?: string }): ResourceDefinition => {
    const r = definitions.get(typeKey(query));
    if (!r) throw new QueryError("Resource type is not configured; call discover_resources for supported apiVersion/kind pairs");
    if (r.scope === "Namespaced") {
      if (!query.namespace || !catalog.namespaces.includes(query.namespace)) throw new QueryError("A permitted namespace is required; call discover_resources");
    } else if (query.namespace !== undefined) {
      throw new QueryError("Cluster-scoped resources must not include namespace");
    }
    return r;
  };
  const read = async (address: ResourceAddress) => {
    const r = resolveType(address);
    return { definition: r, resource: await reader.get(r, address) };
  };
  return {
    discover: () => structuredClone(catalog),
    async list(input: ListQuery) {
      const query = listSchema.parse(input);
      const r = resolveType(query);
      const page = await reader.list(r, query);
      return { items: page.items.map((obj) => sanitize(obj, r)), continue: page.continue };
    },
    async get(input: ResourceAddress) {
      const { definition, resource } = await read(addressSchema.parse(input));
      return sanitize(resource, definition);
    },
    async hierarchy(input: ResourceAddress, maxDepth: number): Promise<Hierarchy> {
      const root = addressSchema.parse(input);
      if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 3) throw new QueryError("maxDepth must be an integer from 0 to 3");
      resolveType(root);
      const result: Hierarchy = { nodes: [], edges: [], truncated: false };
      const queue = [{ address: root, depth: 0 }];
      const visited = new Set([addressKey(root)]);
      let references = 0;
      for (let i = 0; i < queue.length; i++) {
        const { address, depth } = queue[i];
        let current: Awaited<ReturnType<typeof read>>;
        try {
          current = await read(address);
        } catch (e) {
          if (i === 0 || !(e instanceof QueryError)) throw e;
          result.nodes.push({ address, error: e.message });
          continue;
        }
        result.nodes.push({ address, resource: hierarchySummary(sanitize(current.resource, current.definition)) });
        relationships: for (const rel of current.definition.relationships) {
          for (const ref of valuesAt(current.resource, rel.path.split("."))) {
            if (++references > MAX_REFERENCES) {
              result.truncated = true;
              break relationships;
            }
            if (!record(ref) || !nameSchema.safeParse(ref.name).success ||
                (ref.namespace !== undefined && ref.namespace !== "" && !namespaceSchema.safeParse(ref.namespace).success)) {
              throw new QueryError(`Invalid object reference at ${rel.path}`);
            }
            const target = definitions.get(typeKey(rel))!;
            const to = addressSchema.parse({
              apiVersion: rel.apiVersion, kind: rel.kind, name: ref.name,
              namespace: target.scope === "Namespaced" ? (ref.namespace || address.namespace) : undefined,
            });
            if (visited.has(addressKey(to))) {
              result.edges.push({ from: address, to, relationship: rel.name });
              continue;
            }
            if (depth >= maxDepth || queue.length >= MAX_NODES) {
              result.truncated = true;
              continue;
            }
            result.edges.push({ from: address, to, relationship: rel.name });
            visited.add(addressKey(to));
            queue.push({ address: to, depth: depth + 1 });
          }
        }
      }
      return result;
    },
  };
}
