/**
 * Browser notifications (ADR-0069): a projection of `Event` resources, never stored on their own.
 * Rules decide what is worth telling a human; every channel (SSE toast, notification center, desktop) shows the same.
 */
import type { FactoryEvent } from "../model/kinds.ts";
import type { Principal } from "./app.ts";

/** `action`: a human must act or the item stays stuck. `problem`: something went wrong. `info`: good to know. */
export type NotificationSeverity = "action" | "problem" | "info";

export interface FactoryNotification {
  /** The Event's uid: stable dedup key across tabs and reloads. */
  id: string;
  at: string;
  namespace: string;
  severity: NotificationSeverity;
  /** Icon + filter, e.g. "clarification", "approval", "failed", "quota". */
  category: string;
  title: string;
  message: string;
  workItem?: string;
  /** The work item's title: the only text a desktop (lock-screen) notification shows besides `title`. */
  subject?: string;
  /** UI path or absolute URL (e.g. a pull request). */
  link: string;
}

/** What a rule may know besides the Event. Filled by the classifier; rules stay pure. */
export interface NotificationContext {
  workItem?: string;
  workItemTitle?: string;
}

/** The notification-worthy part a rule decides; id, time, namespace and work item come from the Event. */
export type NotificationDraft = Pick<FactoryNotification, "severity" | "category" | "title" | "message" | "link">;

/** One rule per `<involved kind>/<reason>` (kind `*` matches any kind). Registered in the composition root. */
export interface NotificationRule {
  toNotification(event: FactoryEvent, ctx: NotificationContext): NotificationDraft | null;
}

/** Maps a stored Event to a notification, or null when it isn't worth one. */
export interface NotificationClassifier {
  classify(event: FactoryEvent): Promise<FactoryNotification | null>;
}

export interface NotificationQuery {
  /** Only notifications at or after this ISO timestamp (inclusive; clients dedup by id). */
  since?: string;
  /** Default 50, max 200. */
  limit?: number;
}

/** History for the notification center, newest first. v0.4 narrows it to the principal's namespaces. */
export interface NotificationQueries {
  listNotifications(p: Principal, q: NotificationQuery): Promise<FactoryNotification[]>;
}
