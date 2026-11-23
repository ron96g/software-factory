import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

/** ADR-0082: factory-wide metrics (tools, tokens, agent/tool time, checks, cost), optionally windowed by `since`. */
export const GET = handler(({ req, p, f }) => {
  const params = new URL(req.url).searchParams;
  const since = params.get("since") ?? undefined;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  return f.metrics.factory(p, { since, limit });
});
