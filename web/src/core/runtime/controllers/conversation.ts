import type { Conversation } from "../../model/kinds.ts";
import { keyOf, parseKey } from "../../model/meta.ts";
import {
  isStoreError,
  type Controller,
  type ResourceReader,
  type StatusWriter,
  type TranscriptRecorderFactory,
  type TranscriptReader,
  type ConversationTurnRunner,
  type Lookup,
  type InitialKeys,
  type Clock,
  type Redactor,
  type EventRecorder,
  isModelUnavailable,
} from "../../ports/index.ts";

/** Sole owner of Conversation.status, including registered durable chat turns (ADR-0036). */
export function createConversationController(d: {
  reader: ResourceReader;
  status: StatusWriter;
  recorders: TranscriptRecorderFactory;
  transcripts: TranscriptReader;
  turns: Lookup<ConversationTurnRunner>;
  clock: Clock;
  redactor: Redactor;
  events: EventRecorder;
  onError: (message: string) => void;
}): Controller & InitialKeys & { stop(): Promise<void> } {
  const active = new Map<string, Promise<void>>();
  const jobs = new Set<Promise<void>>();
  async function execute(key: string, c: Conversation, runner: ConversationTurnRunner) {
    const turn = c.spec.turn!;
    const recorder = await d.recorders.forConversation(c);
    try {
      const history = await d.transcripts.read(recorder.ref);
      if (!history.some((m) => m.role === "assistant" && m.meta?.turnId === turn.id && m.meta.final === true)) {
        await runner.run(c, recorder);
      }
      const latest = await d.reader.get<Conversation>("Conversation", c.metadata.namespace!, c.metadata.name);
      if (!latest || latest.spec.turn?.id !== turn.id) return;
      active.delete(key);
      const done = await d.status.updateStatus({ ...latest, status: {
        ...latest.status, phase: "Ready", completedTurn: turn.id, activeTurn: turn.id,
        message: undefined, retryAt: undefined, modelWaits: undefined,
        lastMessageAt: d.clock.now().toISOString(),
      } });
      await d.events.normal(done, "ChatAnswered", `${done.spec.agentRef?.name} answered turn ${turn.id}`);
    } catch (e) {
      if (isStoreError(e, "Conflict")) return;
      const latest = await d.reader.get<Conversation>("Conversation", c.metadata.namespace!, c.metadata.name);
      if (!latest || latest.spec.turn?.id !== turn.id) return;
      const message = d.redactor.redact(e instanceof Error ? e.message : String(e));
      const waits = (latest.status?.modelWaits ?? 0) + 1;
      const delay = isModelUnavailable(e) ? Math.min(e.retryAfterMs ?? 60_000 * 2 ** Math.min(waits - 1, 10), 15 * 60_000) : undefined;
      const retryAt = delay === undefined ? undefined : new Date(d.clock.now().getTime() + delay).toISOString();
      await recorder.record({ role: "note", author: { type: "system", id: "conversation" }, content: `${retryAt ? "Waiting" : "Failed"}: ${message}${retryAt ? `; retry at ${retryAt}` : ""}`, meta: { turnId: turn.id } });
      active.delete(key);
      const updated = await d.status.updateStatus({ ...latest, status: {
        ...latest.status, phase: retryAt ? "Waiting" : "Failed", activeTurn: turn.id,
        message, retryAt, modelWaits: retryAt ? waits : undefined,
      } });
      if (!retryAt || waits === 1) await d.events.warning(updated, retryAt ? "ModelUnavailable" : "ChatFailed", message);
    }
  }
  return {
    name: "conversation",
    primaryKind: "Conversation",
    watches: ["Conversation"],
    resyncMs: 10_000,
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    initialKeys: async () => (await d.reader.list<Conversation>("Conversation")).filter((c) => !c.status?.transcriptRef || (c.spec.turn && c.status?.completedTurn !== c.spec.turn.id && !(c.status?.phase === "Failed" && c.status.activeTurn === c.spec.turn.id))).map(keyOf),
    stop: async () => { await Promise.all([...jobs]); },
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const c = await d.reader.get<Conversation>("Conversation", namespace, name);
      if (!c || active.has(key)) return;
      try {
        if (!c.status?.transcriptRef) {
          const rec = await d.recorders.forConversation(c);
          await d.status.updateStatus({ ...c, status: { ...c.status, transcriptRef: rec.ref, phase: c.spec.turn ? "Queued" : undefined } });
          return;
        }
        const runner = d.turns.get(c.spec.purpose);
        const turn = c.spec.turn;
        if (!runner || !turn || c.status.completedTurn === turn.id || (c.status.activeTurn === turn.id && c.status.phase === "Failed")) return;
        const retry = c.status.activeTurn === turn.id ? Date.parse(c.status.retryAt ?? "") - d.clock.now().getTime() : 0;
        if (retry > 0) return { requeueAfterMs: retry };
        if (c.status.phase !== "Running" || c.status.activeTurn !== turn.id) {
          const running = await d.status.updateStatus({ ...c, status: { ...c.status, phase: "Running", activeTurn: turn.id, message: undefined, retryAt: undefined } });
          await d.events.normal(running, "ChatStarted", `${c.spec.agentRef?.name} answering turn ${turn.id}`);
          return;
        }
        const job = execute(key, c, runner)
          .catch((e: unknown) => d.onError(d.redactor.redact(e instanceof Error ? e.message : String(e))))
          .finally(() => {
            if (active.get(key) === job) active.delete(key);
            jobs.delete(job);
          });
        active.set(key, job);
        jobs.add(job);
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}
