import { handler } from "@/server/http.ts";

export const GET = handler<{ name: string }>(async ({ p, f, params }) => f.tickets.review(p, params.name));

export const POST = handler<{ name: string }>(async ({ p, f, params }) => {
  await f.tickets.beginPublication(p, params.name);
  return { started: true };
});
