/**
 * Control-plane ports: queue, controllers, events, clock.
 */
import type { ObjectKey, Resource } from "../model/resource.ts";
import type { WatchEvent } from "./store.ts";

export interface Clock {
  now(): Date;
}

/** Audit trail. Implementations persist `Event` resources. */
export interface EventRecorder {
  normal(involved: Resource, reason: string, message: string): Promise<void>;
  warning(involved: Resource, reason: string, message: string): Promise<void>;
}

/** De-duplicating work queue keyed by string. */
export interface WorkQueue {
  add(key: string): void;
  addAfter(key: string, delayMs: number): void;
}

export interface ReconcileResult {
  requeueAfterMs?: number;
}

/** The only thing a controller must do. */
export interface Reconciler {
  reconcile(key: string): Promise<ReconcileResult | void>;
}

/** Maps store changes to reconcile keys. Kept separate so reconcilers stay storage-agnostic. */
export interface WatchMapper {
  /** Kinds whose changes should trigger this controller. */
  readonly watches: string[];
  keysFor(event: WatchEvent): string[];
}

/** Optional: keys to enqueue at startup (level-triggered resync). */
export interface InitialKeys {
  initialKeys(): Promise<string[]>;
}

export interface Controller extends Reconciler, WatchMapper {
  readonly name: string;
  /** Kind that this controller's keys ("namespace/name") refer to; used to attach error events. */
  readonly primaryKind?: string;
  /** Periodic full resync interval (safety net). */
  readonly resyncMs?: number;
}

export interface ControllerRegistrar {
  register(controller: Controller & Partial<InitialKeys>): void;
}

export interface Lifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Lets non-controllers (e.g. API "sync now") nudge a controller. */
export interface ControllerTrigger {
  trigger(controllerName: string, key: string): void;
}

export type { ObjectKey };

// ── Visible control-loop errors (Q2) ────────────────────────────────────

export interface ReconcileFailure {
  controller: string;
  kind?: string;
  key: string;
  attempt: number;
  error: unknown;
}

/** Told about every failed and recovered reconcile; decides what becomes visible (events). */
export interface ReconcileErrorReporter {
  failed(f: ReconcileFailure): Promise<void>;
  recovered(controller: string, key: string): void;
}

export interface FailingReconcile {
  controller: string;
  kind?: string;
  key: string;
  attempts: number;
  lastError: string;
  since: string;
}

/** Read side: which reconciles are currently failing (system health, UI). */
export interface ControllerHealth {
  failing(): FailingReconcile[];
}
