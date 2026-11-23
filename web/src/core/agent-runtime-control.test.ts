import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunControlServerFactory } from "./adapters/runtime/control.ts";
import type { RunToolSurface } from "./ports/index.ts";

function req(socket: string, method: string, path: string, body?: string, token?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const r = httpRequest({ socketPath: socket, method, path, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => done({ status: res.statusCode ?? 0, text }));
    });
    r.on("error", fail);
    if (body) r.write(body);
    r.end();
  });
}

const surface: RunToolSurface = {
  run: { name: "run-1", namespace: "default" },
  offering: async () => [{ name: "finish", description: "finish", parameters: {} }],
  invoke: async (call) => ({ content: `invoked:${call.name}` }),
};

test("S2-c: the runtime-facing surface is a route allowlist — no decide/review/publish route is reachable", async () => {
  const socket = join(mkdtempSync(join(tmpdir(), "sf-ctl-")), "control.sock");
  const server = await createRunControlServerFactory({ proxy: async () => Response.json({ ok: true }) })
    .start({ endpoint: `unix:${socket}`, surface, modelToken: "sfm_model", toolToken: "sfm_tool" });
  try {
    // The token is required before anything else; nothing is served unauthenticated.
    assert.equal((await req(socket, "GET", "/tools")).status, 401);
    assert.equal((await req(socket, "POST", "/invoke", "{}")).status, 401);
    assert.equal((await req(socket, "POST", "/chat/completions", "{}")).status, 401);
    // A token for the other purpose is not accepted either.
    assert.equal((await req(socket, "GET", "/tools", undefined, "sfm_model")).status, 401);

    // The allowlisted routes work with the right token.
    assert.equal((await req(socket, "GET", "/tools", undefined, "sfm_tool")).status, 200);
    assert.deepEqual(JSON.parse((await req(socket, "POST", "/invoke", JSON.stringify({ name: "finish", arguments: {} }), "sfm_tool")).text), { content: "invoked:finish" });
    assert.equal((await req(socket, "POST", "/chat/completions", "{}", "sfm_model")).status, 200);

    // Every state-changing factory route a sandbox must never reach is a plain 404, whatever the verb.
    for (const path of ["/api/approvals/a/decide", "/api/approvals/a/review", "/api/publish", "/api/workitems/x", "/tools/../api/approvals/a/decide"]) {
      for (const verb of ["GET", "POST"]) {
        assert.equal((await req(socket, verb, path, verb === "POST" ? "{}" : undefined, "sfm_tool")).status, 404, `${verb} ${path} must not be reachable`);
      }
    }

    // An oversized body is refused rather than buffered.
    const big = JSON.stringify({ name: "finish", arguments: { x: "a".repeat(3 * 1024 * 1024) } });
    assert.equal((await req(socket, "POST", "/invoke", big, "sfm_tool")).status, 413);
  } finally {
    await server.close();
  }
});
