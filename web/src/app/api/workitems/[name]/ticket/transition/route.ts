import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ p, f, params, req }) => {
  const input = await req.json() as { requestId: string; revision: string; transitionId: string };
  return f.tickets.requestTransition(p, params.name, input);
});
