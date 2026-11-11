import { handler } from "@/server/http.ts";

export const POST = handler(async ({ req, p, f }) => {
  const { runName } = (await req.json()) as { runName: string };
  return f.app.startConversation(p, runName);
});
