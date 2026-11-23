import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

/** ADR-0082: metrics for one work item — per-run and rolled up (tools, tokens, agent/tool time, checks, cost). */
export const GET = handler<{ name: string }>(({ p, f, params }) => f.metrics.item(p, params.name));
