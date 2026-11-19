import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { artifact, quote, comment } = (await req.json()) as { artifact?: unknown; quote?: unknown; comment?: unknown };
  if (typeof artifact !== "string" || typeof quote !== "string" || typeof comment !== "string") throw new Error("artifact, quote and comment must be text");
  return f.app.addFeedback(p, params.name, { artifact, quote, comment });
});
