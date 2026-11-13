import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";
export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input: unknown = await req.json();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("preview input must be an object");
  const context = "context" in input ? input.context : "";
  if (typeof context !== "string") throw new Error("context must be text");
  return f.app.previewWorkItemFollowUp(p, params.name, context);
});
