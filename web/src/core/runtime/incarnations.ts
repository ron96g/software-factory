import type { AgentProcessKiller, WorkspaceLock } from "../ports/index.ts";

/** Lock holders that identify a process incarnation (ADR-0062 §2). */
export const INCARNATION_PREFIXES = ["web:", "worker:", "all:"] as const;

/** The identity this process uses as a lock holder; override with `FACTORY_INCARNATION`. */
export function incarnationId(role: string, env: Record<string, string | undefined> = process.env, pid = process.pid): string {
  return env.FACTORY_INCARNATION ?? `${role}:${pid}`;
}

/**
 * ADR-0062 §2: a starting process releases a **previous** incarnation's locks only after that incarnation's agent
 * processes are **confirmed gone** — otherwise the stale holder might still be writing to a workspace the new process
 * now owns. A holder that cannot be confirmed dead keeps its locks and needs attention.
 */
export async function reapStaleIncarnations(d: { lock: WorkspaceLock; killer: AgentProcessKiller; current: string }): Promise<string[]> {
  const holders = new Set((await d.lock.list()).map((l) => l.holder).filter((h) => INCARNATION_PREFIXES.some((p) => h.startsWith(p))));
  const reaped: string[] = [];
  for (const holder of holders) {
    if (holder === d.current) continue;
    if (await d.killer.kill(holder)) {
      await d.lock.releaseHolder(holder);
      reaped.push(holder);
    }
  }
  return reaped;
}

/**
 * The default killer. Agent process groups are not recorded yet (the sandbox would have to report each child's pgid), so
 * it can never confirm a previous incarnation is gone and nothing is released — the safe choice until that wiring lands.
 */
export class NoProcessKiller implements AgentProcessKiller {
  async kill(): Promise<boolean> {
    return false;
  }
}
