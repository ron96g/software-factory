import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { title, content, tags } = (await req.json()) as { title?: string; content?: string; tags?: string[] };
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) throw new Error("tags must be a list of strings");
  return f.app.updateKnowledge(p, params.name, { title, content, tags });
});
