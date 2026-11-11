import { spawn } from "node:child_process";
import type { ExecResult } from "../../ports/index.ts";

const OUTPUT_CAP = 64 * 1024;
/** ADR-0020: only these variables reach commands; no factory secrets. */
const SAFE_ENV = ["PATH", "HOME", "LANG", "TERM", "USER"];

export function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])) as NodeJS.ProcessEnv;
}

/** Runs `bash -lc <command>` with a scrubbed env, a timeout (kills the process group) and an output cap. */
export function runScrubbed(command: string, cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: scrubbedEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const add = (cur: string, chunk: Buffer) => {
      if (cur.length >= OUTPUT_CAP) {
        truncated = true;
        return cur;
      }
      return (cur + chunk.toString()).slice(0, OUTPUT_CAP);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = add(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = add(stderr, c)));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      stderr += `\n[killed after ${timeoutMs} ms timeout]`;
    }, timeoutMs);
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      done({ exitCode: code ?? 137, stdout, stderr, truncated, durationMs: Date.now() - started });
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      done({ exitCode: 127, stdout, stderr: String(e), truncated, durationMs: Date.now() - started });
    });
  });
}
