import type { FactoryEvent, WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  FactoryNotification,
  Lookup,
  NotificationClassifier,
  NotificationQueries,
  NotificationQuery,
  NotificationRule,
  Principal,
  Redactor,
  ResourceReader,
} from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";

export const ruleKey = (kind: string, reason: string) => `${kind}/${reason}`;
export const MESSAGE_MAX = 160;

/**
 * Looks up the rule for `<kind>/<reason>` (falling back to `*\/<reason>`); uncatalogued reasons never notify.
 * Event messages can carry raw error text (failed runs, failing control loops), so messages are redacted.
 */
export class RuleBasedNotificationClassifier implements NotificationClassifier {
  private readonly d: { rules: Lookup<NotificationRule>; reader: ResourceReader; redactor: Redactor };
  constructor(d: { rules: Lookup<NotificationRule>; reader: ResourceReader; redactor: Redactor }) {
    this.d = d;
  }

  async classify(event: FactoryEvent): Promise<FactoryNotification | null> {
    const { kind, name } = event.spec.involvedObject;
    const rule = this.d.rules.get(ruleKey(kind, event.spec.reason)) ?? this.d.rules.get(ruleKey("*", event.spec.reason));
    if (!rule || !event.metadata.uid) return null;
    const namespace = nsOf(event);
    const workItem = kind === "WorkItem" ? name : event.metadata.labels?.[LABEL_WORKITEM];
    const item = workItem ? await this.d.reader.get<WorkItem>("WorkItem", namespace, workItem).catch(() => null) : null;
    const draft = rule.toNotification(event, { workItem, workItemTitle: item?.spec.title });
    if (!draft) return null;
    return {
      id: event.metadata.uid,
      at: event.metadata.creationTimestamp ?? new Date(0).toISOString(),
      namespace,
      ...draft,
      message: truncate(this.d.redactor.redact(draft.message), MESSAGE_MAX),
      ...(workItem ? { workItem } : {}),
      ...(item?.spec.title ? { subject: item.spec.title } : {}),
    };
  }
}

/** Notification center history: classified Events, newest first. */
export class EventNotificationFeed implements NotificationQueries {
  private readonly d: { reader: ResourceReader; classifier: NotificationClassifier };
  constructor(d: { reader: ResourceReader; classifier: NotificationClassifier }) {
    this.d = d;
  }

  async listNotifications(_p: Principal, q: NotificationQuery): Promise<FactoryNotification[]> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    // In-memory filtering is fine for the single-process SQLite store; a timestamp selector is a v1.0 concern.
    // Inclusive `since`: Events in the cursor's own millisecond aren't lost; clients dedup by id.
    const events = (await this.d.reader.list<FactoryEvent>("Event"))
      .filter((e) => !q.since || (e.metadata.creationTimestamp ?? "") >= q.since)
      .sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""));
    const out: FactoryNotification[] = [];
    for (const e of events) {
      const n = await this.d.classifier.classify(e);
      if (n) out.push(n);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
