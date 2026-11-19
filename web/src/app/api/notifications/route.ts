import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

/** Notification center history (ADR-0069): `?since=<ISO>&limit=<n>`, newest first. */
export const GET = handler(({ req, p, f }) => {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit"));
  return f.notifications.listNotifications(p, {
    since: url.searchParams.get("since") ?? undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
});
