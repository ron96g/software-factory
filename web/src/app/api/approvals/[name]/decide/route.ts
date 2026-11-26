import type { ReviewVerdict } from "@/core/model/kinds.ts";
import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { decision, comment, override, verdict } = (await req.json()) as { decision: "approve" | "reject"; comment?: string; override?: boolean; verdict?: ReviewVerdict };
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  return f.app.decideApproval(p, params.name, decision, comment, override === true, verdict);
});
