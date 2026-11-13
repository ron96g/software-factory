#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCatalog } from "./config.ts";
import { createKubernetesReader, loadKubeConfig } from "./kubernetes.ts";
import { QueryError } from "./ports.ts";
import { createCrQueries } from "./queries.ts";
import { createServer } from "./server.ts";

async function main() {
  const { values } = parseArgs({
    options: { config: { type: "string" }, kubeconfig: { type: "string" }, context: { type: "string" }, help: { type: "boolean" } },
    strict: true,
  });
  if (values.help) {
    console.error("Usage: kubernetes-cr-mcp --config <catalog.yaml> [--kubeconfig <path>] [--context <name>]\nRead-only stdio MCP server. Uses the operator's kubeconfig; never writes to the cluster.");
    return;
  }
  if (!values.config) throw new QueryError("--config <catalog.yaml> is required");
  const catalog = await loadCatalog(values.config);
  const config = loadKubeConfig(values);
  const server = createServer(createCrQueries(catalog, createKubernetesReader(config)));
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(e instanceof QueryError ? e.message : "Cannot start Kubernetes CR MCP server; check CLI arguments and local configuration");
  process.exitCode = 1;
});
