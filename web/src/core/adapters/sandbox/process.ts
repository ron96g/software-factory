import { spawn } from "node:child_process";
import type { ExecResult } from "../../ports/index.ts";

const OUTPUT_CAP = 64 * 1024;
/** ADR-0020: only these variables reach commands; no factory secrets. */
const SAFE_ENV = ["PATH", "HOME", "LANG", "TERM", "USER"];

export function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])) as NodeJS.ProcessEnv;
}

/**
 * Runs `bash -lc <command>` with a scrubbed env (plus the profile's plain `env`, ADR-0033), a timeout (kills the
 * process group) and an output cap.
 */
export function runScrubbed(command: string, cwd: string, timeoutMs = 120_000, env: Record<string, string> = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...scrubbedEnv(), ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timeoutNotice = "";
    let truncated = false;
    let timedOut = false;
    const add = (cur: Buffer, chunk: Buffer) => {
      const available = OUTPUT_CAP - cur.length;
      if (chunk.length > available) truncated = true;
      return available === 0 ? cur : Buffer.concat([cur, chunk.subarray(0, available)]);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = add(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = add(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      timeoutNotice = `\n[killed after ${timeoutMs} ms timeout]`;
    }, timeoutMs);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      done({ exitCode: code ?? 137, stdout: stdout.toString(), stderr: stderr.toString() + timeoutNotice, truncated, durationMs: Date.now() - started,
        termination: timedOut ? { kind: "timeout", signal: signal ?? undefined } : signal ? { kind: "signal", signal } : { kind: "exit" } });
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      done({ exitCode: 127, stdout: stdout.toString(), stderr: String(e), truncated, durationMs: Date.now() - started, termination: { kind: "spawn-error" } });
    });
  });
}
