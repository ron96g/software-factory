export interface ResourceType {
  apiVersion: string;
  kind: string;
}

export interface Relationship extends ResourceType {
  name: string;
  path: string;
}

export interface ResourceDefinition extends ResourceType {
  plural: string;
  scope: "Namespaced" | "Cluster";
  description?: string;
  relationships: Relationship[];
  redactPaths: string[];
}

export interface Catalog {
  namespaces: string[];
  resources: ResourceDefinition[];
}

export interface ResourceAddress extends ResourceType {
  name: string;
  namespace?: string;
}

export interface ListQuery extends ResourceType {
  namespace?: string;
  labelSelector?: string;
  limit?: number;
  continue?: string;
}

export interface ResourceObject extends ResourceType {
  metadata: {
    name: string;
    namespace?: string;
    [key: string]: unknown;
  };
  spec?: unknown;
  status?: unknown;
}

export interface ResourcePage {
  items: ResourceObject[];
  continue?: string;
}

export interface CustomResourceReader {
  get(type: ResourceDefinition, address: ResourceAddress): Promise<ResourceObject>;
  list(type: ResourceDefinition, query: ListQuery): Promise<ResourcePage>;
}

export interface Hierarchy {
  /** Node resources contain identity, version/generation and condition summaries; get() returns full details. */
  nodes: { address: ResourceAddress; resource?: ResourceObject; error?: string }[];
  edges: { from: ResourceAddress; to: ResourceAddress; relationship: string }[];
  truncated: boolean;
}

export interface CrQueries {
  discover(): Catalog;
  list(query: ListQuery): Promise<ResourcePage>;
  get(address: ResourceAddress): Promise<ResourceObject>;
  hierarchy(address: ResourceAddress, maxDepth: number): Promise<Hierarchy>;
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}
