import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler(({ p, f }) => f.app.browsableKinds(p));
