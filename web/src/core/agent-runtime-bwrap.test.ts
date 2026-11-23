import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapAgentRuntime } from "./adapters/runtime/bwrap.ts";
import { GitBundleIngest } from "./adapters/workspaces/git-export.ts";

const RUNNER = join(import.meta.dirname, "../agent-runtime/runner.ts");
const TOOLS = [
  { name: "finish", description: "finish", parameters: { type: "object", properties: { summary: { type: "string" } } } },
  { name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "run", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

function gitRepo(): { path: string; commit: string } {
  const path = mkdtempSync(join(tmpdir(), "sf-runtime-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: path });
  g("init", "-q", "-b", "main");
  writeFileSync(join(path, "a.txt"), "one\n");
  g("add", ".");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: path });
  return { path, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path }).toString().trim() };
}

test("S2-b: the loop runs inside bwrap, reaches only the Unix socket, and exports a candidate bundle", async (t) => {
  const runtime = new BwrapAgentRuntime({ root: mkdtempSync(join(tmpdir(), "sf-runtime-root-")), runnerPath: RUNNER });
  const health = await runtime.health();
  if (!health.available) { t.skip(`bwrap unavailable: ${health.message}`); return; }

  const run = { name: "run-e2e", namespace: "default" };
  const socket = runtime.socketPath(run);
  mkdirSync(runtime.jobDir(run), { recursive: true, mode: 0o700 }); // the caller binds the surface before `create`
  let seenAuth = "";
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const json = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/tools") { seenAuth = String(req.headers.authorization ?? ""); return json({ tools: TOOLS }); }
      if (req.url === "/invoke") return json({ content: "ok" });
      if (req.url === "/chat/completions") {
        calls++;
        const call = (name: string, args: unknown) => ({ id: `c${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
        if (calls === 1) return json({ choices: [{ message: { content: "checking the sandbox", tool_calls: [call("run", { command: "echo HOME=$HOME; (exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo NET-OK || echo NET-BLOCKED" })] } }] });
        if (calls === 2) return json({ choices: [{ message: { content: null, tool_calls: [call("write_file", { path: "b.txt", content: "hello from the runtime\n" })] } }] });
        return json({ choices: [{ message: { content: null, tool_calls: [call("finish", { summary: "done", artifacts: [{ type: "candidate", content: "# done" }] })] } }] });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));

  const seed = gitRepo();
  const job = await runtime.create({
    run, namespace: "default", image: "bwrap@process",
    profile: { metadata: { name: "node-build" }, spec: { isolation: "process", acceptWeakerIsolation: true } } as never,
    seeds: [{ repository: "repo", commit: seed.commit, path: seed.path }],
    model: { baseUrl: `unix:${socket}`, name: "test-model" },
    tools: { baseUrl: `unix:${socket}` },
    task: { system: "SYSTEM", user: "do it", maxSteps: 6, protocol: 1 },
    budgets: { ttlSeconds: 60 },
  }, { modelToken: "sfm_test", toolToken: "sfm_tool" });

  try {
    const result = await job.wait();
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.finish, { summary: "done", artifacts: [{ type: "candidate", content: "# done" }] });
    assert.equal(seenAuth, "Bearer sfm_tool", "the run tool surface is reached with the out-of-band token");

    const events = await job.events();
    assert.ok(events.some((e) => e.role === "tool-call" && e.meta?.tool === "write_file"), "the workspace tool ran inside the runtime");
    assert.ok(events.some((e) => e.role === "tool-result" && /HOME=\/tmp\/home/.test(e.content)), "the sandbox has an ephemeral HOME (not the factory's)");
    assert.ok(events.some((e) => e.role === "tool-result" && /NET-BLOCKED/.test(e.content)), "egress is denied (--unshare-net): only the socket is reachable");

    const exported = await job.export();
    const mirror = `${mkdtempSync(join(tmpdir(), "sf-mirror-"))}.git`;
    const ingested = await new GitBundleIngest().ingest({ bundlePath: exported.bundlePath, mirrorPath: mirror, ref: exported.ref });
    assert.match(ingested.commit, /^[0-9a-f]{40}$/);
    // The candidate tree (read through plumbing, never checked out) contains the file the agent wrote.
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", ingested.commit], { cwd: mirror }).toString();
    assert.match(tree, /^b\.txt$/m);
  } finally {
    await job.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
