import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(async ({ p, f, params }) => {
  const d = await f.app.getWorkItem(p, params.name);
  if (!d) throw new Error(`work item ${params.name} not found`);
  return d;
});
