import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { decision, comment } = (await req.json()) as { decision: "approve" | "reject"; comment?: string };
  return f.app.reviewKnowledge(p, params.name, decision, comment);
});
