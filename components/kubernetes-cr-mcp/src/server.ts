import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addressSchema, hierarchySchema, listSchema } from "./config.ts";
import { QueryError, type CrQueries } from "./ports.ts";

export function createServer(queries: CrQueries): McpServer {
  const server = new McpServer({ name: "kubernetes-cr-mcp", version: "0.1.0" });
  const invoke = async (fn: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
    } catch (e) {
      const message = e instanceof QueryError ? e.message : e instanceof z.ZodError
        ? "Invalid tool arguments; check the tool schema"
        : "CR query failed unexpectedly; check the server configuration";
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  server.registerTool("discover_resources", {
    description: "Discover configured CR apiVersion/kind pairs, scopes, permitted namespaces and directed reference hierarchy. This is the operator's allowlist, not proof CRDs are installed. Call before querying.",
    inputSchema: z.object({}).strict(), annotations,
  }, () => invoke(() => queries.discover()));
  server.registerTool("list_resources", {
    description: "List one configured CR type by exact apiVersion/kind and permitted namespace (omit namespace only for Cluster scope). Optional Kubernetes labelSelector, limit 1-100 (default 10), and continue token for the next page. Returns redacted metadata/spec/status; no all-namespace listing.",
    inputSchema: listSchema, annotations,
  }, (args) => invoke(() => queries.list(args)));
  server.registerTool("get_resource", {
    description: "Read a configured CR by exact apiVersion, kind, name and permitted namespace. Omit namespace only for Cluster scope. Returns redacted observed spec/status and metadata.",
    inputSchema: addressSchema, annotations,
  }, (args) => invoke(() => queries.get(args)));
  server.registerTool("get_resource_hierarchy", {
    description: "Read a CR and follow its YAML-configured forward object references. Provide exact apiVersion, kind, name and namespace; maxDepth 0-3 (default 2), max 25 nodes. Node resources are compact identity/version/generation and condition summaries (type/status/reason/observedGeneration); use get_resource for full spec/status and condition messages. Returns directed edges, per-node errors and explicit truncation; not a whole-cluster or reverse-reference scan.",
    inputSchema: hierarchySchema, annotations,
  }, ({ maxDepth, ...address }) => invoke(() => queries.hierarchy(address, maxDepth)));
  return server;
}
