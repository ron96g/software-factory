import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler(({ p, f }) => f.app.listWorkItems(p));

export const POST = handler(async ({ req, p, f }) => {
  const { title, description, context, workflowRef, repositoryRefs } = (await req.json()) as {
    title: string;
    description?: string;
    context?: string;
    workflowRef?: string;
    repositoryRefs?: string[];
  };
  if (repositoryRefs !== undefined && (!Array.isArray(repositoryRefs) || repositoryRefs.some((r) => typeof r !== "string"))) {
    throw new Error("repositoryRefs must be a list of names");
  }
  return f.app.createWorkItem(p, { title, description, context: typeof context === "string" ? context : undefined, workflowRef: workflowRef || undefined, repositoryRefs });
});
