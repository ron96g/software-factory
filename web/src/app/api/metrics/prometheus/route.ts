import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

/**
 * ADR-0082: Prometheus/OpenMetrics text for scraping (Grafana's Prometheus data source). Same window options as
 * `/api/metrics` (`?since=&limit=`). Unrecorded metrics are omitted, not exported as zero.
 */
export const GET = handler(async ({ req, p, f }) => {
  const params = new URL(req.url).searchParams;
  const since = params.get("since") ?? undefined;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const { contentType, body } = await f.metricsExport.export(p, { since, limit });
  return new Response(body, { headers: { "content-type": contentType } });
});
