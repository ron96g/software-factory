import type { ModuleCheckScope, Repository, Workspace } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { CommandRunner, EventRecorder, GateCheckLookup, GateContext, GateDecision, GateEvaluator, ModuleScopePlanner, Redactor, ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { resolveCheckConfig } from "../checks/config.ts";

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
  redactor: Redactor;
  pollMs?: number;
  scopes?: ModuleScopePlanner;
}): GateEvaluator {
  const running = new Map<string, Promise<void>>();
  const results = new Map<string, Result>();
  const warned = new Set<string>();

  async function runCommand(key: string, ctx: GateContext, ws: Workspace, repos: Repository[], name: string, command: string, timeoutMs: number, scope?: ModuleCheckScope) {
    try {
      const r = await d.runner.run(ws, repos, command, timeoutMs);
      const tail = d.redactor.redact(r.output.slice(-1500)); // ADR-0015: command output can echo env/config
      const passed = r.exitCode === 0;
      results.set(key, { passed, message: `${ws.spec.repositoryRef.name}: \`${command}\` → exit ${r.exitCode} (${r.durationMs} ms)\n${tail}` });
      const msg = `${name} on ${ws.spec.repositoryRef.name}: exit ${r.exitCode} in ${r.durationMs} ms${scope ? `\nScope: ${scope.mode}; ${scope.reason}\nCommand: ${command}` : ""}${passed ? "" : `\n${tail}`}`;
      if (passed) await d.events.normal(ctx.workItem, "CheckPassed", msg);
      else await d.events.warning(ctx.workItem, "CheckFailed", msg);
    } catch (e) {
      // Infrastructure errors (no sandbox, workspace gone) are not check failures: don't cache, so they re-run
      // instead of consuming the retry budget.
      const message = d.redactor.redact(e instanceof Error ? e.message : String(e));
      await d.events.warning(ctx.workItem, "CheckError", `${name}: ${message}`);
    }
  }

  return {
    type: "automated",
    async evaluate(ctx): Promise<GateDecision> {
      const wi = ctx.workItem;
      const ns = nsOf(wi);
      const base = `${ns}/${wi.metadata.name}/${ctx.stage.name}/r${wi.status?.round ?? 0}`;
      const all = await d.reader.list<Workspace>("Workspace", { namespace: ns, ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: ns } });
      if (all.some((w) => w.status?.phase !== "Ready")) return { action: "wait", retryAfterMs: d.pollMs ?? 2000 };
      const workspaces = all;
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
        const targets = [];
        for (const ws of workspaces) {
          const repo = repos.find((r) => r.metadata.name === ws.spec.repositoryRef.name);
          if (repo?.spec.checks?.[name]) targets.push({ ws, ...await resolveCheckConfig(repo, name, ws, d.scopes) });
        }
        if (!targets.length) {
          const wkey = `${base}/${name}`;
          if (!warned.has(wkey)) {
            warned.add(wkey);
            await d.events.warning(wi, "CheckNotImplemented", `automated check "${name}" has no implementation or repository command; passing (MVP)`);
          }
          continue;
        }
        for (const { ws, command, timeoutMs, scope } of targets) {
          const key = `${base}/${name}/${ws.metadata.name}`;
          const done = results.get(key);
          if (done) {
            if (!done.passed) failures.push(`${name}: ${done.message}`);
            continue;
          }
          pending = true;
          if (!running.has(key)) {
            running.set(key, runCommand(key, ctx, ws, repos, name, command, timeoutMs, scope).finally(() => running.delete(key)));
          }
        }
      }
      if (pending) return { action: "wait", retryAfterMs: d.pollMs ?? 2000 };
      // Decided: drop this round's cache entries (bounded memory).
      for (const k of [...results.keys(), ...warned]) if (k.startsWith(`${base}/`)) (results.delete(k), warned.delete(k));
      if (!failures.length) return { action: "advance" };
      // The retry budget (status.retries) is counted by the WorkItem controller (it owns status).
      const retry = (ctx.gate.onFailure as { retry?: { next?: string; maxAttempts?: number } } | undefined)?.retry;
      const attempts = (wi.status?.retries?.[ctx.stage.name] ?? 0) + 1;
      const reason = failures.join("\n\n");
      if (retry?.next && attempts <= (retry.maxAttempts ?? 1)) return { action: "goto", stage: retry.next, retryOf: ctx.stage.name };
      return { action: "fail", reason: `checks failed after ${attempts} attempt(s):\n${reason}` };
    },
  };
}
