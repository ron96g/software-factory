import { handler } from "@/server/http.ts";
import type { DraftFollowUpTicketInput } from "@/core/ports/work-item-followups.ts";

export const dynamic = "force-dynamic";
export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input = await req.json() as DraftFollowUpTicketInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("draft input must be an object");
  return f.app.draftFollowUpTicket(p, params.name, input);
});
