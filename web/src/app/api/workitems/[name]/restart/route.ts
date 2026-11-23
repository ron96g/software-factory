import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { stage, context, includeDraftNotes } = ((await req.json().catch(() => ({}))) ?? {}) as { stage?: string; context?: string; includeDraftNotes?: boolean };
  if (stage !== undefined && typeof stage !== "string") throw new Error("stage must be a string");
  if (context !== undefined && typeof context !== "string") throw new Error("context must be text");
  if (includeDraftNotes !== undefined && typeof includeDraftNotes !== "boolean") throw new Error("includeDraftNotes must be true or false");
  return f.app.restartWorkItem(p, params.name, stage || undefined, { context, includeDraftNotes });
});
