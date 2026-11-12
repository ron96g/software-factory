import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { context } = (await req.json()) as { context?: unknown };
  if (typeof context !== "string") throw new Error("context must be text");
  return f.app.updateWorkItemContext(p, params.name, context);
});
