import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(({ p, f, params }) => f.app.retireKnowledge(p, params.name));
