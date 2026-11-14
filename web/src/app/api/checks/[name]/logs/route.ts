import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

export const GET = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const value = new URL(req.url).searchParams.get("afterSeq");
  if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new Error("afterSeq must be a non-negative integer");
  }
  const messages = (await f.checkRuns.logs(p, params.name, value === null ? undefined : Number(value))).slice(0, PAGE_SIZE);
  return { messages, nextAfterSeq: messages.at(-1)?.seq ?? null, hasMore: messages.length === PAGE_SIZE };
});
