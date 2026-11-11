import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(({ p, f, params }) => f.app.runTranscript(p, params.name));
