import type { Repository, Workspace } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { CommandRunner, EventRecorder, GateCheckLookup, GateContext, GateDecision, GateEvaluator, ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

type Result = { passed: boolean; message: string };

/**
 * ADR-0023 `automated` gate. Each check runs once per (item, stage, round) in the background; while any is running the
 * gate answers `wait`, so reconciles never block. Registered GateChecks win; otherwise the repository's command is used.
 * Results are cached in memory; after a restart checks simply run again (idempotent).
 */
export function automatedGate(d: {
  checks: GateCheckLookup;
  events: EventRecorder;
  reader: ResourceReader;
  runner: CommandRunner;
  pollMs?: number;
}): GateEvaluator {
  const running = new Map<string, Promise<void>>();
  const results = new Map<string, Result>();
  const warned = new Set<string>();

  async function runCommand(key: string, ctx: GateContext, ws: Workspace, repos: Repository[], name: string, command: string) {
    try {
      const r = await d.runner.run(ws, repos, command);
      const tail = r.output.slice(-1500);
      const passed = r.exitCode === 0;
      results.set(key, { passed, message: `${ws.spec.repositoryRef.name}: \`${command}\` → exit ${r.exitCode} (${r.durationMs} ms)\n${tail}` });
      const msg = `${name} on ${ws.spec.repositoryRef.name}: exit ${r.exitCode} in ${r.durationMs} ms${passed ? "" : `\n${tail}`}`;
      if (passed) await d.events.normal(ctx.workItem, "CheckPassed", msg);
      else await d.events.warning(ctx.workItem, "CheckFailed", msg);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.set(key, { passed: false, message });
      await d.events.warning(ctx.workItem, "CheckFailed", `${name}: ${message}`);
    }
  }

  return {
    type: "automated",
    async evaluate(ctx): Promise<GateDecision> {
      const wi = ctx.workItem;
      const ns = nsOf(wi);
      const base = `${ns}/${wi.metadata.name}/${ctx.stage.name}/r${wi.status?.round ?? 0}`;
      const workspaces = (await d.reader.list<Workspace>("Workspace", { namespace: ns, ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: ns } })).filter(
        (w) => w.status?.phase === "Ready",
      );
      const repos = (
        await Promise.all(workspaces.map((w) => resolveRef<Repository>(d.reader, "Repository", w.spec.repositoryRef, ns)))
      ).filter((r): r is Repository => !!r);

      let pending = false;
      const failures: string[] = [];
      for (const name of ctx.gate.checks ?? []) {
        const registered = d.checks.get(name);
        if (registered) {
          const r = await registered.run(ctx);
          if (!r.passed) failures.push(`${name}: ${r.message ?? "failed"}`);
          continue;
        }
        const targets = workspaces.flatMap((ws) => {
          const cmd = repos.find((r) => r.metadata.name === ws.spec.repositoryRef.name)?.spec.checks?.[name];
          return cmd ? [{ ws, cmd }] : [];
        });
        if (!targets.length) {
          const wkey = `${base}/${name}`;
          if (!warned.has(wkey)) {
            warned.add(wkey);
            await d.events.warning(wi, "CheckNotImplemented", `automated check "${name}" has no implementation or repository command; passing (MVP)`);
          }
          continue;
        }
        for (const { ws, cmd } of targets) {
          const key = `${base}/${name}/${ws.metadata.name}`;
          const done = results.get(key);
          if (done) {
            if (!done.passed) failures.push(`${name}: ${done.message}`);
            continue;
          }
          pending = true;
          if (!running.has(key)) {
            running.set(key, runCommand(key, ctx, ws, repos, name, cmd).finally(() => running.delete(key)));
          }
        }
      }
      if (pending) return { action: "wait", retryAfterMs: d.pollMs ?? 2000 };
      if (!failures.length) return { action: "advance" };
      const retry = (ctx.gate.onFailure as { retry?: { next?: string; maxAttempts?: number } } | undefined)?.retry;
      const attempts = (wi.status?.checkFailures?.[ctx.stage.name] ?? 0) + 1;
      const reason = failures.join("\n\n");
      if (retry?.next && attempts <= (retry.maxAttempts ?? 1)) return { action: "goto", stage: retry.next, retryOf: ctx.stage.name };
      return { action: "fail", reason: `checks failed after ${attempts} attempt(s):\n${reason}` };
    },
  };
}
