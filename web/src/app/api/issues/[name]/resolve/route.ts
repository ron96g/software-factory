import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { action, externalId } = (await req.json()) as { action: "create-again" | "link"; externalId?: string };
  return f.app.resolveIssueProposal(p, params.name, { action, externalId });
});
