import { isModelUnavailable, ModelProxyError, type ModelProxy, type ModelProxyRequest } from "../../ports/index.ts";

/**
 * ADR-0080 §4: the OpenAI-shaped surface of the model proxy. It authenticates by the run-scoped token only — the
 * provider key never leaves the factory — and maps a refusal or a quota wait to the status the caller must see.
 */
export function createModelProxyHttpHandler(o: { proxy: ModelProxy }) {
  return async (req: Request): Promise<Response> => {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) {
      return Response.json({ error: "unauthorized: a run-scoped model token is required (ADR-0080 §4)" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    let body: ModelProxyRequest;
    try {
      body = (await req.json()) as ModelProxyRequest;
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    try {
      const result = await o.proxy.chatCompletions(token, body);
      return Response.json(result.body ?? null, { status: 200 });
    } catch (e) {
      if (e instanceof ModelProxyError) return Response.json({ error: e.message }, { status: e.status });
      if (isModelUnavailable(e)) {
        const retryAfter = e.retryAfterMs != null ? String(Math.max(0, Math.ceil(e.retryAfterMs / 1000))) : undefined;
        return Response.json({ error: e.message }, { status: 503, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) });
      }
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  };
}
