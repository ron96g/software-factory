import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) =>
  f.retrospectives.recordOutcome(p, params.name, await req.json()));
