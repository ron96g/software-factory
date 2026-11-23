/**
 * ADR-0080 §2–§5: the runtime-side agent loop — the **data plane**. This program runs *inside* the `AgentRuntime`
 * (bwrap): it reaches only the model proxy and the run tool surface (both served on a Unix socket in the job
 * directory), executes workspace tools against its own clone, and exports the candidate commit as a bundle. It holds
 * no provider key: only the ephemeral run token it reads from `secrets.env` and deletes before doing anything else.
 *
 * It is deliberately self-contained (node builtins only) so the runtime image is just this file plus a Node binary.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";

interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
interface ToolCall { id: string; function: { name: string; arguments?: string } }
interface JobSpec {
  run: { name: string };
  seeds: { repository: string; commit: string; path?: string }[];
  model: { baseUrl: string; name?: string };
  tools: { baseUrl: string };
  task: { system: string; user: string; maxSteps: number; protocol: number };
  budgets: { ttlSeconds: number };
}

const LOCAL_TOOLS = new Set(["read_file", "list_files", "search_code", "write_file", "run", "git_diff"]);
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const MAX_TOOL_RESULT = 16 * 1024;

const jobDir = process.env.FACTORY_JOB_DIR;
if (!jobDir) die("FACTORY_JOB_DIR is not set");
const seqState = { n: 0 };

function die(message: string): never {
  try { writeFileSync(join(jobDir!, "result.json"), JSON.stringify({ status: "failed", message })); } catch { /* best effort */ }
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function record(role: string, content: string, meta?: Record<string, unknown>) {
  const seq = ++seqState.n;
  appendFileSync(join(jobDir!, "events.jsonl"), `${JSON.stringify({ seq, role, content, ...(meta ? { meta } : {}) })}\n`);
}

/** Minimal HTTP client that also speaks Unix-domain sockets (`unix:<path>`); the only factory endpoints it can reach. */
function send(baseUrl: string, method: string, path: string, body: unknown, token: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const opts: import("node:http").RequestOptions = { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } };
    if (baseUrl.startsWith("unix:")) { opts.socketPath = baseUrl.slice(5); opts.path = path; }
    else { const u = new URL(baseUrl); opts.host = u.hostname; opts.port = u.port; opts.path = u.pathname.replace(/\/$/, "") + path; }
    const req = httpRequest(opts, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, text: data }));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_SAFE, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 }).toString();
}

function readSecrets(path: string): { modelToken: string; toolToken: string } {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const env: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim(); // a token may contain "="
  }
  rmSync(path, { force: true }); // the token is not persisted after the run starts
  return { modelToken: env.FACTORY_MODEL_TOKEN ?? "", toolToken: env.FACTORY_TOOL_TOKEN ?? "" };
}

/** Resolves a workspace-relative path, refusing escapes (the runner's own clone is the only writable tree). */
function safePath(work: string, p: unknown): string {
  const rel = String(p ?? "");
  const abs = resolve(work, rel);
  const r = relative(work, abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new Error(`path escapes the workspace: ${rel}`);
  return abs;
}

function localTool(work: string, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file": return readFileSync(safePath(work, args.path), "utf8").slice(0, MAX_TOOL_RESULT);
    case "write_file": {
      const abs = safePath(work, args.path);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(abs, String(args.content ?? ""));
      return `wrote ${args.path}`;
    }
    case "list_files": return git(work, "ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean).slice(0, 500).join("\n") || "(no files)";
    case "search_code": return git(work, "grep", "-n", "-I", "-e", String(args.query ?? ""), "--", ".").split("\n").slice(0, 200).join("\n") || "(no matches)";
    case "run": return runCommand(work, String(args.command ?? ""), Number(args.timeoutMs) || 120_000);
    case "git_diff": return git(work, "diff", "HEAD");
    default: throw new Error(`"${name}" is not a workspace tool`);
  }
}

function runCommand(work: string, command: string, timeoutMs: number): string {
  try {
    const out = execFileSync("bash", ["-lc", command], { cwd: work, timeout: timeoutMs, maxBuffer: MAX_TOOL_RESULT, stdio: ["ignore", "pipe", "pipe"] });
    return out.toString() || "(no output)";
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number; message?: string };
    const text = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim();
    return `exit ${err.status ?? "?"}${text ? `\n${text}` : `\n${err.message ?? ""}`}`.slice(0, MAX_TOOL_RESULT);
  }
}

async function main() {
  const secrets = readSecrets(join(jobDir!, "secrets.env"));
  if (!existsSync(join(jobDir!, "job.json"))) die("job.json is missing");
  const spec = JSON.parse(readFileSync(join(jobDir!, "job.json"), "utf8")) as JobSpec;
  if (spec.task?.protocol !== 1) die(`unsupported run job protocol ${String(spec.task?.protocol)}`);

  if (spec.seeds.length !== 1) die(`expected exactly one seed, got ${spec.seeds.length}`);
  const seed = spec.seeds[0];
  const work = join(jobDir!, "work");
  mkdirSync(work, { recursive: true });
  git(jobDir!, "clone", "--quiet", join(jobDir!, "seed.bundle"), work);
  git(work, "checkout", "--quiet", "--detach", seed.commit, "--");
  record("system", `seeded ${seed.repository}@${seed.commit.slice(0, 10)} inside the runtime`);

  const offering = JSON.parse((await send(spec.tools.baseUrl, "GET", "/tools", undefined, secrets.toolToken)).text).tools as ToolSchema[];

  const messages: unknown[] = [
    { role: "system", content: spec.task.system },
    { role: "user", content: spec.task.user },
  ];
  let finish: unknown;
  let steps = 0;

  for (let step = 1; step <= spec.task.maxSteps && finish === undefined; step++) {
    steps = step;
    const final = step === spec.task.maxSteps;
    if (final) {
      messages.push({ role: "user", content: `[harness] Last model step (budget ${spec.task.maxSteps}). Only \`finish\` is available: report what you completed.` });
    }
    const res = await send(spec.model.baseUrl, "POST", "/chat/completions", {
      model: spec.model.name, messages, tools: final ? offering.filter((t) => t.name === "finish") : offering,
    }, secrets.modelToken);
    if (res.status === 429 || res.status === 503 || res.status === 529) {
      writeFileSync(join(jobDir!, "result.json"), JSON.stringify({ status: "waiting", message: `model unavailable (proxy HTTP ${res.status})`, usage: { steps } }));
      return;
    }
    if (res.status < 200 || res.status >= 300) die(`model proxy HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const json = JSON.parse(res.text) as { choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[] };
    const message = json.choices?.[0]?.message ?? {};
    if (message.content) record("assistant", message.content);
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      messages.push({ role: "assistant", content: message.content ?? "" });
      messages.push({ role: "user", content: "Continue using the tools, or call `finish` when you are done." });
      continue;
    }
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      record("tool-call", JSON.stringify(args), { tool: name, step });
      if (name === "finish") {
        const r = await send(spec.tools.baseUrl, "POST", "/invoke", { name, arguments: args }, secrets.toolToken);
        const content = (JSON.parse(r.text) as { content: string }).content;
        if (content === "ok") { finish = args; break; }
        record("tool-result", content, { tool: name, step });
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
        continue;
      }
      let result: string;
      try {
        result = LOCAL_TOOLS.has(name)
          ? localTool(work, name, args)
          : (JSON.parse((await send(spec.tools.baseUrl, "POST", "/invoke", { name, arguments: args }, secrets.toolToken)).text) as { content: string }).content;
      } catch (e) {
        result = `tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
      record("tool-result", result.slice(0, MAX_TOOL_RESULT), { tool: name, step });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: result.slice(0, MAX_TOOL_RESULT) });
    }
  }

  if (finish === undefined) die(`did not finish within ${spec.task.maxSteps} steps`);

  git(work, "add", "-A");
  try {
    git(work, "-c", "user.email=factory@local", "-c", "user.name=software-factory", "commit", "-qm", `runtime candidate for ${spec.run.name}`);
  } catch { /* no changes to commit: the candidate is the seed commit */ }
  git(work, "branch", "-f", "factory/candidate", "HEAD");
  git(work, "bundle", "create", join(jobDir!, "out.bundle"), "factory/candidate");
  writeFileSync(join(jobDir!, "result.json"), JSON.stringify({ status: "succeeded", finish, usage: { steps } }));
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
