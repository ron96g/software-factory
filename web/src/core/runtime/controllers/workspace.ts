import type { Repository, Workspace } from "../../model/kinds.ts";
import { keyOf, nsOf, parseKey } from "../../model/meta.ts";
import {
  isStoreError,
  type Controller,
  type EventRecorder,
  type InitialKeys,
  type Redactor,
  type ResourceReader,
  type StatusWriter,
  type WorkspaceCleaner,
  type WorkspacePreparer,
  type WorkspaceSweeper,
} from "../../ports/index.ts";
import { resolveRef } from "../../refs/refs.ts";

/**
 * Owns Workspace.status (ADR-0021). Preparation (clone/worktree + setup) runs outside the reconcile with an
 * in-flight guard, like AgentRuns. Deletion cleans up the files; the deleted object is kept from the watch event.
 */
export function createWorkspaceController(d: {
  reader: ResourceReader;
  status: StatusWriter;
  events: EventRecorder;
  preparer: WorkspacePreparer;
  cleaner: WorkspaceCleaner;
  sweeper: WorkspaceSweeper;
  redactor: Redactor;
  sweepMs?: number;
}): Controller & InitialKeys {
  const SWEEP = "sweep/all";
  const inFlight = new Set<string>();
  const deleted = new Map<string, Workspace>();

  async function prepare(key: string, ws: Workspace) {
    try {
      const repo = await resolveRef<Repository>(d.reader, "Repository", ws.spec.repositoryRef, nsOf(ws));
      if (!repo) throw new Error(`repository ${ws.spec.repositoryRef.name} not found`);
      let cur = ws;
      if (cur.status?.phase !== "Preparing") {
        cur = await d.status.updateStatus({ ...cur, status: { ...cur.status, phase: "Preparing" } });
        await d.events.normal(cur, "Preparing", `${repo.metadata.name} → ${ws.spec.branch}${ws.spec.setup?.length ? ` (setup: ${ws.spec.setup.join(" && ")})` : ""}`);
      }
      const p = await d.preparer.prepare(cur, repo);
      const latest = (await d.reader.get<Workspace>("Workspace", nsOf(ws), ws.metadata.name))!;
      const ready = await d.status.updateStatus({ ...latest, status: { phase: "Ready", ...p, setupLog: p.setupLog ? d.redactor.redact(p.setupLog) : undefined } });
      await d.events.normal(ready, "Ready", `${p.path} @ ${p.baseCommit.slice(0, 10)}`);
    } catch (e) {
      const message = d.redactor.redact(e instanceof Error ? e.message : String(e));
      try {
        const latest = await d.reader.get<Workspace>("Workspace", nsOf(ws), ws.metadata.name);
        if (latest) {
          await d.status.updateStatus({ ...latest, status: { ...latest.status, phase: "Failed", message } });
          await d.events.warning(latest, "Failed", message);
        }
      } catch (inner) {
        if (!isStoreError(inner)) throw inner; // conflict/not found: the next reconcile/resync observes the state
      }
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    name: "workspace",
    watches: ["Workspace"],
    keysFor: (e) => {
      const key = keyOf(e.object);
      if (e.type === "DELETED") deleted.set(key, e.object as Workspace);
      return [key];
    },
    // Level-triggered cleanup (sweep) at startup and periodically; the DELETED event is only a fast path.
    initialKeys: async () => [
      SWEEP,
      ...(await d.reader.list<Workspace>("Workspace")).filter((w) => w.status?.phase !== "Ready" && w.status?.phase !== "Failed").map(keyOf),
    ],
    resyncMs: d.sweepMs ?? 10 * 60_000,

    async reconcile(key) {
      if (key === SWEEP) {
        const live = (await d.reader.list<Workspace>("Workspace")).map((w) => ({ workItem: w.spec.workItemRef.name, repository: w.spec.repositoryRef.name }));
        await d.sweeper.sweep(live);
        return;
      }
      const { namespace, name } = parseKey(key);
      const ws = await d.reader.get<Workspace>("Workspace", namespace, name);
      if (!ws) {
        const gone = deleted.get(key);
        if (!gone) return;
        const repo = await resolveRef<Repository>(d.reader, "Repository", gone.spec.repositoryRef, namespace);
        await d.cleaner.remove(gone, repo); // throws → manager retries with backoff
        deleted.delete(key);
        return;
      }
      if (ws.status?.phase === "Ready" || ws.status?.phase === "Failed" || inFlight.has(key)) return;
      inFlight.add(key);
      void prepare(key, ws).catch((e) => {
        if (!isStoreError(e)) throw e;
      });
    },
  };
}
