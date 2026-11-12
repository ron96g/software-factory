import { handler } from "@/server/http.ts";

export const POST = handler<{ name: string }>(({ p, f, params }) => f.app.startKnowledgeConversation(p, params.name));
