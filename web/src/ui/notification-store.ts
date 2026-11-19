"use client";
import { useSyncExternalStore } from "react";
import type { FactoryNotification, NotificationSeverity } from "@/core/ports/notifications.ts";

/**
 * Per-browser notification state (ADR-0069 §5). Without auth there is no user to attach read state to;
 * v0.4 moves read state and settings to the User, and only this module changes.
 */
export interface NotificationSettings {
  desktop: boolean;
  desktopSeverities: NotificationSeverity[];
}

interface Persisted {
  /** Everything at or before this time counts as read. */
  readAt?: string;
  /** Read individually after `readAt` (capped). */
  readIds: string[];
  /** Newest notification time this browser has received: the catch-up cursor. */
  cursor?: string;
  settings: NotificationSettings;
}

export interface NotificationSnapshot {
  items: FactoryNotification[];
  unread: number;
  settings: NotificationSettings;
  isUnread(n: FactoryNotification): boolean;
}

const KEY = "sf.notifications.v1";
const MAX_ITEMS = 100;
const MAX_READ_IDS = 500;
const DEFAULT_SETTINGS: NotificationSettings = { desktop: false, desktopSeverities: ["action", "problem"] };

let items: FactoryNotification[] = [];
let state: Persisted = { readIds: [], settings: DEFAULT_SETTINGS };
let loaded = false;
const subscribers = new Set<() => void>();

function readPersisted() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      state = { readIds: p.readIds ?? [], readAt: p.readAt, cursor: p.cursor, settings: { ...DEFAULT_SETTINGS, ...p.settings } };
    }
  } catch {}
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  readPersisted();
  // Other tabs mark things read too: keep unread counts in sync. Registered once, with `loaded`.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    readPersisted();
    emit(false);
  });
}

function save() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

const isUnread = (n: FactoryNotification) => n.at > (state.readAt ?? "") && !state.readIds.includes(n.id);

let snapshot: NotificationSnapshot = { items, unread: 0, settings: state.settings, isUnread };
function emit(persist = true) {
  snapshot = { items, unread: items.filter(isUnread).length, settings: state.settings, isUnread };
  if (persist) save();
  subscribers.forEach((s) => s());
}

/** True until this browser has loaded notification history once. */
export function needsBaseline(): boolean {
  load();
  return state.readAt === undefined;
}

export function catchUpCursor(): string | undefined {
  load();
  return state.cursor;
}

/**
 * Adds notifications, dropping ids already known; returns the new ones.
 * `baseline`: the first history load in this browser marks everything loaded as read.
 */
export function addNotifications(list: FactoryNotification[], opts: { baseline?: boolean } = {}): FactoryNotification[] {
  load();
  const known = new Set(items.map((n) => n.id));
  const added = list.filter((n) => !known.has(n.id));
  if (!added.length && !opts.baseline) return [];
  items = [...added, ...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS);
  const newest = items[0]?.at;
  if (newest && newest > (state.cursor ?? "")) state = { ...state, cursor: newest };
  if (opts.baseline) state = { ...state, readAt: newest ?? new Date().toISOString() };
  emit();
  return added;
}

export function markRead(id: string) {
  load();
  if (state.readIds.includes(id)) return;
  state = { ...state, readIds: [...state.readIds, id].slice(-MAX_READ_IDS) };
  emit();
}

export function markAllRead() {
  load();
  const newest = items[0]?.at;
  if (newest && newest > (state.readAt ?? "")) state = { ...state, readAt: newest, readIds: [] };
  else state = { ...state, readIds: [...new Set([...state.readIds, ...items.map((n) => n.id)])].slice(-MAX_READ_IDS) };
  emit();
}

export function updateSettings(patch: Partial<NotificationSettings>) {
  load();
  state = { ...state, settings: { ...state.settings, ...patch } };
  emit();
}

export function currentSettings(): NotificationSettings {
  load();
  return state.settings;
}

const SERVER_SNAPSHOT: NotificationSnapshot = { items: [], unread: 0, settings: DEFAULT_SETTINGS, isUnread: () => false };

export function useNotificationState(): NotificationSnapshot {
  return useSyncExternalStore(
    (cb) => {
      load();
      subscribers.add(cb);
      if (snapshot.settings !== state.settings) emit(false);
      return () => subscribers.delete(cb);
    },
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}
