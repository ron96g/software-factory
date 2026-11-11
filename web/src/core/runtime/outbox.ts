import type { OutboxMessage, Source, WorkItem, Clarification } from "../model/kinds.ts";
import { API_VERSION, DEFAULT_NAMESPACE } from "../model/resource.ts";
import { keyOf, ownerOf, parseKey } from "../model/meta.ts";
import {
  FACTORY_COMMENT_MARKER,
  canComment,
  canReadComments,
  isStoreError,
  type Clock,
  type Controller,
  type EventRecorder,
  type InitialKeys,
  type Lookup,
  type Outbox,
  type OutboundMessage,
  type OutboxHandler,
  type Redactor,
  type ResourceReader,
  type ResourceWriter,
  type SourceConnector,
  type StatusWriter,
} from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

/** Outbox backed by OutboxMessage resources. The key is the name, so enqueueing is idempotent. */
export class StoreOutbox implements Outbox {
  private readonly writer: ResourceWriter;
  constructor(writer: ResourceWriter) {
    this.writer = writer;
  }
  async enqueue(m: OutboundMessage): Promise<void> {
    const msg: OutboxMessage = {
      apiVersion: API_VERSION,
      kind: "OutboxMessage",
      metadata: {
        name: m.key,
        namespace: m.namespace,
        ownerReferences: m.owner ? [m.owner] : [],
        labels: { "factory.ai-dlc.io/action": m.action, ...(m.source ? { "factory.ai-dlc.io/source": m.source } : {}) },
      },
      spec: {
        ...(m.source ? { sourceRef: { name: m.source } } : {}),
        ...(m.externalId ? { externalId: m.externalId } : {}),
        action: m.action,
        payload: m.payload,
      },
      status: { phase: "Pending", attempts: 0 },
    };
    try {
      await this.writer.create(msg);
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
    }
  }
}

/** Outbox action "comment": posts through any connector that supports CommentPublisher. */
export function commentHandler(connectors: Lookup<SourceConnector>): OutboxHandler {
  return {
    action: "comment",
    async deliver({ source, externalId, payload }) {
      if (!source || !externalId) throw new Error("comment needs a source item");
      const c = connectors.get(source.spec.type);
      if (!c || !canComment(c)) throw new Error(`source type "${source.spec.type}" cannot publish comments`);
      await c.postComment(source, externalId, `${String(payload.body ?? "")}\n\n${FACTORY_COMMENT_MARKER}`);
    },
  };
}

const MAX_ATTEMPTS = 8;

/** Delivers OutboxMessages with exponential backoff (ADR-0005). Owns OutboxMessage.status. */
export function createOutboxController(d: {
  reader: ResourceReader;
  status: StatusWriter;
  events: EventRecorder;
  clock: Clock;
  handlers: Lookup<OutboxHandler>;
  redactor: Redactor;
}): Controller & InitialKeys {
  return {
    name: "outbox",
    watches: ["OutboxMessage"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    initialKeys: async () =>
      (await d.reader.list<OutboxMessage>("OutboxMessage")).filter((m) => m.status?.phase === "Pending").map(keyOf),
    resyncMs: 60_000,
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const msg = await d.reader.get<OutboxMessage>("OutboxMessage", namespace, name);
      if (!msg || msg.status?.phase !== "Pending") return;
      const due = msg.status.nextAttemptAt ? Date.parse(msg.status.nextAttemptAt) - d.clock.now().getTime() : 0;
      if (due > 0) return { requeueAfterMs: due };

      const attempts = (msg.status.attempts ?? 0) + 1;
      try {
        let source: Source | undefined;
        if (msg.spec.sourceRef) {
          source = (await resolveRef<Source>(d.reader, "Source", msg.spec.sourceRef, namespace)) ?? undefined;
          if (!source) throw new Error(`source ${msg.spec.sourceRef.name} not found`);
        }
        const handler = d.handlers.get(msg.spec.action);
        if (!handler) throw new Error(`no outbox handler for action "${msg.spec.action}"`);
        const result = (await handler.deliver({ source, externalId: msg.spec.externalId, payload: msg.spec.payload })) ?? undefined;
        await d.status.updateStatus({ ...msg, status: { phase: "Delivered", attempts, result: result ? JSON.parse(d.redactor.redact(JSON.stringify(result))) : undefined } });
        await d.events.normal(
          msg,
          "Delivered",
          `${msg.spec.action}${msg.spec.sourceRef ? ` → ${msg.spec.sourceRef.name}#${msg.spec.externalId}` : ""}${result && typeof result.url === "string" ? ` · ${result.url}` : ""}`,
        );
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        const lastError = d.redactor.redact(e instanceof Error ? e.message : String(e));
        const failed = attempts >= MAX_ATTEMPTS;
        const delay = Math.min(1000 * 2 ** attempts, 15 * 60_000);
        await d.status.updateStatus({
          ...msg,
          status: {
            phase: failed ? "Failed" : "Pending",
            attempts,
            lastError,
            nextAttemptAt: failed ? undefined : new Date(d.clock.now().getTime() + delay).toISOString(),
          },
        });
        await d.events.warning(msg, failed ? "DeliveryFailed" : "DeliveryRetry", `attempt ${attempts}: ${lastError}`);
        return failed ? undefined : { requeueAfterMs: delay };
      }
    },
  };
}

/**
 * Polls the source for human replies to open clarifications on synced items (W3).
 * Writes Clarification.spec.answers on behalf of the human (sync writes spec, ADR-0002).
 */
export function createClarificationSyncController(d: {
  reader: ResourceReader;
  writer: ResourceWriter;
  events: EventRecorder;
  connectors: Lookup<SourceConnector>;
  pollMs: number;
}): Controller & InitialKeys {
  return {
    name: "clarification-sync",
    watches: ["Clarification"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    initialKeys: async () =>
      (await d.reader.list<Clarification>("Clarification")).filter((c) => !c.spec.answers?.length).map(keyOf),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const c = await d.reader.get<Clarification>("Clarification", namespace, name);
      if (!c || c.spec.answers?.length) return;
      const wiRef = ownerOf(c, "WorkItem");
      const wi = wiRef ? await d.reader.get<WorkItem>("WorkItem", namespace, wiRef.name) : null;
      if (!wi?.spec.externalRef) return; // manual items are answered in the UI only
      const source = await resolveRef<Source>(d.reader, "Source", wi.spec.sourceRef, namespace ?? DEFAULT_NAMESPACE);
      const connector = source ? d.connectors.get(source.spec.type) : undefined;
      if (!source || !connector || !canReadComments(connector) || !source.spec.sync?.bidirectional) return;

      const comments = await connector.listComments(source, wi.spec.externalRef.id, c.metadata.creationTimestamp);
      const replies = comments.filter(
        (x) => !x.body.includes(FACTORY_COMMENT_MARKER) && (!c.metadata.creationTimestamp || x.createdAt >= c.metadata.creationTimestamp),
      );
      if (!replies.length) return { requeueAfterMs: d.pollMs };
      const answer = replies.map((r) => r.body.trim()).join("\n\n");
      try {
        await d.writer.update<Clarification>({
          ...c,
          spec: { ...c.spec, answers: [answer], answeredBy: `${source.metadata.name}:${replies.map((r) => r.author).join(",")}` },
        });
        await d.events.normal(wi, "AnsweredAtSource", `reply by ${replies[0].author} on ${source.metadata.name}#${wi.spec.externalRef.id}`);
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}
