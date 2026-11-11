import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ kind: string }>(({ p, f, params }) => f.app.listDefinitions(p, params.kind));
