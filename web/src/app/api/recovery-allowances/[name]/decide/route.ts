import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { decision, reason } = await req.json() as { decision: "approve" | "reject"; reason: string };
  return f.recoveryAllowances.decide(p, params.name, decision, reason);
});
