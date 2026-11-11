import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler(({ p, f }) => f.app.listWorkItems(p));

export const POST = handler(async ({ req, p, f }) => {
  const body = (await req.json()) as { title: string; description?: string; repositoryRefs?: string[] };
  return f.app.createWorkItem(p, body);
});
