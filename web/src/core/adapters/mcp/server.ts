import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExposedTool, Principal, Redactor } from "../../ports/index.ts";

export const MCP_PRINCIPAL: Principal = { id: "mcp", roles: [], squads: [] };
/** Set by the factory's own MCP client on calls made for an agent run (ADR-0034). */
export const AGENT_RUN_HEADER = "x-factory-agent-run";
/** Optional label a harness sends to tell its calls apart in events (e.g. "vscode"). */
export const CLIENT_HEADER = "x-factory-client";

const label = (v: string | null) => (v ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 100);

/** Builds an MCP server exposing the given tools. Results are JSON text; errors become `isError` results. */
export function buildMcpServer(all: ExposedTool[], o: { principal: Principal; agent: boolean; redactor: Redactor; version?: string }): Server {
  // Rule 8: an agent calling back must not answer its own questions, restart itself, or create work.
  const tools = o.agent ? all.filter((t) => !t.humanOnly) : all;
  const server = new Server({ name: "software-factory", version: o.version ?? "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as never, annotations: t.annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = tools.find((x) => x.name === req.params.name);
    if (!t) {
      const human = o.agent && all.some((x) => x.name === req.params.name);
      return { isError: true, content: [{ type: "text", text: human ? `"${req.params.name}" is for humans only (rule 8)` : `unknown tool "${req.params.name}"` }] };
    }
    try {
      const result = await t.invoke(o.principal, (req.params.arguments ?? {}) as Record<string, unknown>);
      // Defence in depth (ADR-0015): nothing that looks like a known secret leaves the factory.
      return { content: [{ type: "text", text: o.redactor.redact(JSON.stringify(result ?? null, null, 2)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: o.redactor.redact(e instanceof Error ? e.message : String(e)) }] };
    }
  });
  return server;
}

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * ADR-0034: Streamable HTTP endpoint (stateless: a fresh server + transport per request). Disabled without a token;
 * every request must carry `Authorization: Bearer <token>`.
 */
export function createMcpHttpHandler(o: { tools: () => ExposedTool[]; token: string | undefined; redactor: Redactor }) {
  return async (req: Request): Promise<Response> => {
    if (!o.token) {
      return Response.json({ error: "MCP is disabled: set FACTORY_MCP_TOKEN (ADR-0034)" }, { status: 503 });
    }
    const auth = req.headers.get("authorization") ?? "";
    const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!given || !sameToken(given, o.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    const run = label(req.headers.get(AGENT_RUN_HEADER));
    const client = label(req.headers.get(CLIENT_HEADER));
    const principal: Principal = run ? { ...MCP_PRINCIPAL, id: `agent:${run}` } : client ? { ...MCP_PRINCIPAL, id: `mcp:${client}` } : MCP_PRINCIPAL;
    const server = buildMcpServer(o.tools(), { principal, agent: !!run, redactor: o.redactor });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
