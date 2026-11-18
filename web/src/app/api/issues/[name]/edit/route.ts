import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const patch = (await req.json()) as { title?: string; body?: string; issueType?: string; labels?: string[]; pickUp?: boolean; targetSource?: string };
  return f.app.updateIssueProposal(p, params.name, patch);
});
