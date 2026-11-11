import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(({ p, f, params }) => f.app.conversationMessages(p, params.name));

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { text } = (await req.json()) as { text: string };
  return f.app.sendMessage(p, params.name, text ?? "");
});
