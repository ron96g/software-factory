import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ plural: string }>(({ p, f, params }) => f.app.listResources(p, params.plural));
