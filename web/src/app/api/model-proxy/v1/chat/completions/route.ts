import { getFactory } from "@/server/factory-instance.ts";

export const dynamic = "force-dynamic";

/** ADR-0080 §4: the model proxy. Authenticated by a run-scoped token (`Authorization: Bearer sfm_…`), never by the UI session. */
async function handle(req: Request): Promise<Response> {
  const f = await getFactory();
  return f.modelProxy(req);
}

export const POST = handle;
