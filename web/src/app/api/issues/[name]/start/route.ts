import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input = (await req.json().catch(() => ({}))) as { workflowRef?: string; repositories?: string[] };
  return f.app.startImplementation(p, params.name, input);
});
