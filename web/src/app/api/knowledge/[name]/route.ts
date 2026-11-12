import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(async ({ p, f, params }) => {
  const d = await f.app.getKnowledge(p, params.name);
  if (!d) throw new Error(`knowledge entry ${params.name} not found`);
  return d;
});
