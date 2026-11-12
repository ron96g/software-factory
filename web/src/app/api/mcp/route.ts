import { getFactory } from "@/server/factory-instance.ts";

export const dynamic = "force-dynamic";

/** ADR-0034: MCP (Streamable HTTP). Auth: `Authorization: Bearer $FACTORY_MCP_TOKEN`; disabled without a token. */
async function handle(req: Request): Promise<Response> {
  const f = await getFactory();
  return f.mcp(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
