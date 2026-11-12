import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { stage } = ((await req.json().catch(() => ({}))) ?? {}) as { stage?: string };
  if (stage !== undefined && typeof stage !== "string") throw new Error("stage must be a string");
  return f.app.restartWorkItem(p, params.name, stage || undefined);
});
