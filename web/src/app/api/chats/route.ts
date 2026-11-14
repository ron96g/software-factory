import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";
export const GET = handler(({ req, p, f }) => f.app.listAgentChats(p, new URL(req.url).searchParams.get("workItem") ?? undefined));
export const POST = handler(async ({ req, p, f }) => {
  const { agent, title, workItem } = await req.json();
  return f.app.startAgentChat(p, agent, title, workItem);
});
