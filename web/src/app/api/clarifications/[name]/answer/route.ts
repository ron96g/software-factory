import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const { answers } = (await req.json()) as { answers: string[] };
  return f.app.answerClarification(p, params.name, answers ?? []);
});
