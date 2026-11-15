import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input = await req.json() as { requestId: string; count: number; target: "diagnosis" | "repair" | "execution-recovery"; reason: string };
  return f.recoveryAllowances.request(p, params.name, input);
});
