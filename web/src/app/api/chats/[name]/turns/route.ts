import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { id, text } = await req.json();
  return f.app.submitAgentChatTurn(p, params.name, { id, text });
});
