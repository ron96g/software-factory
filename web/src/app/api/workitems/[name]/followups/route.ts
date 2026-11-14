import { handler } from "@/server/http.ts";
import type { NewFollowUpInput } from "@/core/ports/work-item-followups.ts";

export const dynamic = "force-dynamic";
export const GET = handler<{ name: string }>(({ p, f, params }) => f.app.workItemFollowUps(p, params.name));
export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input = await req.json() as NewFollowUpInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("follow-up input must be an object");
  return f.app.createWorkItemFollowUp(p, params.name, input);
});
