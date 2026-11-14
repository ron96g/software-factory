import { handler } from "@/server/http.ts";
import type { NewWorkItemInput } from "@/core/ports/app.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input: NewWorkItemInput = await req.json();
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("title is required");
  for (const value of [input.description, input.context, input.workflowRef]) {
    if (value !== undefined && typeof value !== "string") throw new Error("description, context and workflowRef must be strings");
  }
  if (input.repositoryRefs !== undefined && (!Array.isArray(input.repositoryRefs) || input.repositoryRefs.some((r) => typeof r !== "string"))) throw new Error("repositoryRefs must be a list of names");
  return f.app.createChatWorkItem(p, params.name, input);
});
