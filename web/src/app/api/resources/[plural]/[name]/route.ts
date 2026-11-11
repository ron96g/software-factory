import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ plural: string; name: string }>(async ({ p, f, params }) => {
  const r = await f.app.getResource(p, params.plural, params.name);
  if (!r) throw new Error(`${params.plural}/${params.name} not found`);
  return r;
});
