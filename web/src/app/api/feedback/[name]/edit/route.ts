import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { comment } = (await req.json()) as { comment?: unknown };
  if (typeof comment !== "string") throw new Error("comment must be text");
  return f.app.updateFeedback(p, params.name, comment);
});
