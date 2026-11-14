import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ p, f, params, req }) => {
  const input = await req.json() as { revision: string; visibility: "public" | "internal"; transitionId?: string };
  return f.tickets.approvePublication(p, params.name, input);
});
