import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";
export const GET = handler<{ name: string }>(async ({ p, f, params }) => {
  const detail = await f.app.getAgentChat(p, params.name);
  if (!detail) throw new Error("agent chat not found");
  return detail;
});
