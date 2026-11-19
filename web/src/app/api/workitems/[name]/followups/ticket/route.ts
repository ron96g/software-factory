import { handler } from "@/server/http.ts";
import type { NewFollowUpTicketInput } from "@/core/ports/work-item-followups.ts";

export const dynamic = "force-dynamic";
export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input = await req.json() as NewFollowUpTicketInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ticket input must be an object");
  return f.app.createFollowUpTicket(p, params.name, input);
});
