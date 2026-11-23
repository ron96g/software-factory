import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { RunToolSurface, RuntimeControlServer, RuntimeControlServerFactory } from "../../ports/index.ts";
import { RunToolSurfaceError } from "../../ports/index.ts";

const MAX_BODY = 2 * 1024 * 1024;

/**
 * ADR-0080 §4/§5: the runtime-facing control surface for one run — the model proxy and the run tool surface, served on
 * a single endpoint the runtime can reach and nothing else. Only two routes reach the factory (`/chat/completions` for
 * the proxy, `/tools` + `/invoke` for the surface); every other path is a 404, so no decide/review/publish route is
 * reachable from the runtime (S0-2). Bodies are bounded and the token is checked before any body is read.
 */
export function createRunControlServerFactory(d: { proxy: (req: Request) => Promise<Response> }): RuntimeControlServerFactory {
  return {
    start: (input) => startServer(input, d.proxy),
  };
}

function startServer(input: { endpoint: string; surface: RunToolSurface; modelToken: string; toolToken: string }, proxy: (req: Request) => Promise<Response>): Promise<RuntimeControlServer> {
  const socketPath = input.endpoint.startsWith("unix:") ? input.endpoint.slice(5) : undefined;
  const server = createServer((req, res) => void handle(req, res, input, proxy));
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return new Promise((done, fail) => {
    server.on("error", fail);
    const listen = async () => {
      if (socketPath) await rm(socketPath, { force: true }).catch(() => {}); // a stale socket from a crash must not block a retry
      if (socketPath) server.listen(socketPath, () => done(handle_(server, input.endpoint, socketPath)));
      else {
        const url = new URL(input.endpoint);
        server.listen(Number(url.port), url.hostname, () => done(handle_(server, input.endpoint)));
      }
    };
    void listen().catch(fail);
  });
}

function handle_(server: Server, endpoint: string, socketPath?: string): RuntimeControlServer {
  let closed = false;
  return {
    endpoint,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((r) => server.close(() => r()));
      if (socketPath) await rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, input: { surface: RunToolSurface; modelToken: string; toolToken: string }, proxy: (req: Request) => Promise<Response>): Promise<void> {
  const send = (status: number, payload: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const token = bearer(req.headers.authorization);
  try {
    // Only the allowlisted routes are ever considered; the token is checked before any body is read.
    if (req.method === "POST" && (req.url === "/chat/completions" || req.url?.startsWith("/model-proxy"))) {
      if (!sameToken(token, input.modelToken)) { send(401, { error: "unauthorized (ADR-0080 §4)" }); return; }
      const body = await readBody(req);
      const response = await proxy(toRequest(req, body));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method === "GET" && req.url === "/tools") {
      if (!sameToken(token, input.toolToken)) { send(401, { error: "unauthorized (ADR-0080 §5)" }); return; }
      send(200, { tools: await input.surface.offering() });
      return;
    }
    if (req.method === "POST" && req.url === "/invoke") {
      if (!sameToken(token, input.toolToken)) { send(401, { error: "unauthorized (ADR-0080 §5)" }); return; }
      const parsed = JSON.parse(await readBody(req)) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== "string") { send(400, { error: "a tool name is required" }); return; }
      send(200, await input.surface.invoke({ name: parsed.name, arguments: (parsed.arguments ?? {}) as Record<string, unknown> }));
      return;
    }
    send(404, { error: "not found" });
  } catch (e) {
    if (e instanceof RunToolSurfaceError) send(e.status, { error: e.message });
    else send(e instanceof Error && e.message === "body too large" ? 413 : 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

function bearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const auth = value ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function sameToken(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  return new Request(`http://runtime${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body,
  });
}
