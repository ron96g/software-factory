import { parsePlanningRevision } from "@/planning-request.ts";
import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(({ p, f, params }) => f.planning.inspect(p, params.name));

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input: unknown = await req.json();
  return f.planning.revise(p, params.name, parsePlanningRevision(input));
});
