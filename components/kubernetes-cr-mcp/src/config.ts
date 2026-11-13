import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { QueryError, type Catalog } from "./ports.ts";

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const fieldPath = /^(?:spec|status|metadata)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))+$/;
export const namespaceSchema = z.string().min(1).max(63).regex(dnsLabel);
export const nameSchema = z.string().min(1).max(253).regex(dnsName);
export const resourceTypeShape = {
  apiVersion: z.string().max(320).regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/[a-z][a-z0-9]*$/),
  kind: z.string().min(1).max(63).regex(/^[A-Za-z][A-Za-z0-9]*$/),
};
export const addressSchema = z.object({
  ...resourceTypeShape,
  name: nameSchema,
  namespace: namespaceSchema.optional(),
}).strict();
export const listSchema = z.object({
  ...resourceTypeShape,
  namespace: namespaceSchema.optional(),
  labelSelector: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  continue: z.string().max(8192).optional(),
}).strict();
export const hierarchySchema = addressSchema.extend({ maxDepth: z.number().int().min(0).max(3).default(2) });

const relationshipSchema = z.object({
  ...resourceTypeShape,
  name: z.string().min(1).max(100),
  path: z.string().max(512).regex(fieldPath),
}).strict();
const catalogSchema = z.object({
  namespaces: z.array(namespaceSchema).max(100),
  resources: z.array(z.object({
    ...resourceTypeShape,
    plural: z.string().min(1).max(63).regex(dnsLabel),
    scope: z.enum(["Namespaced", "Cluster"]),
    description: z.string().max(1000).optional(),
    relationships: z.array(relationshipSchema).max(30).default([]),
    redactPaths: z.array(z.string().max(512).regex(/^(?:spec|status)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))+$/)).max(100).default([]),
  }).strict()).min(1).max(100),
}).strict();

export function parseCatalog(yaml: string): Catalog {
  let document: unknown;
  try {
    document = parse(yaml);
  } catch {
    throw new QueryError("Cannot parse catalog YAML");
  }
  const parsed = catalogSchema.safeParse(document);
  if (!parsed.success) {
    throw new QueryError(`Invalid catalog: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const catalog = parsed.data;
  const keys = new Set<string>();
  const endpoints = new Set<string>();
  for (const r of catalog.resources) {
    const key = `${r.apiVersion}/${r.kind}`;
    const endpoint = `${r.apiVersion}/${r.plural}`;
    if (keys.has(key) || endpoints.has(endpoint)) throw new QueryError(`Duplicate resource type or endpoint: ${key}`);
    keys.add(key);
    endpoints.add(endpoint);
    if (r.scope === "Namespaced" && !catalog.namespaces.length) throw new QueryError("Namespaced resources require permitted namespaces");
    const names = new Set<string>();
    for (const rel of r.relationships) {
      if (names.has(rel.name)) throw new QueryError(`Duplicate relationship on ${key}: ${rel.name}`);
      names.add(rel.name);
    }
  }
  for (const r of catalog.resources) {
    for (const rel of r.relationships) {
      if (!keys.has(`${rel.apiVersion}/${rel.kind}`)) throw new QueryError(`Relationship target is not configured: ${rel.apiVersion}/${rel.kind}`);
    }
  }
  return catalog;
}

export const expandHome = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export async function loadCatalog(path: string): Promise<Catalog> {
  let yaml: string;
  try {
    yaml = await readFile(expandHome(path), "utf8");
  } catch {
    throw new QueryError("Cannot read catalog; provide an existing YAML file with --config");
  }
  return parseCatalog(yaml);
}
