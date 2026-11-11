"use client";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface ChangeNotice {
  type: string;
  kind?: string;
  name?: string;
  workItem?: string;
}

// ── one shared EventSource for the whole tab ──────────────────────────────
type Listener = (n: ChangeNotice) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;

function ensureSource() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/watch");
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (e) => {
    const n = JSON.parse(e.data) as ChangeNotice;
    if (n.type === "hello") return setConnected(true);
    listeners.forEach((l) => l(n));
  };
}
function setConnected(v: boolean) {
  connected = v;
  statusListeners.forEach((l) => l());
}

export function useLiveStatus(): boolean {
  useEffect(ensureSource, []);
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => connected,
    () => false,
  );
}

/** Fetches JSON and refetches (debounced) whenever a matching change notice arrives. */
export function useLive<T>(url: string | null, matches: (n: ChangeNotice) => boolean = () => true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const matchRef = useRef(matches);
  matchRef.current = matches;

  const load = useCallback(async () => {
    if (!url) return;
    try {
      setData(await api<T>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [url]);

  useEffect(() => {
    ensureSource();
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const l: Listener = (n) => {
      if (!matchRef.current(n)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      clearTimeout(timer);
    };
  }, [load]);

  return { data, error, reload: load };
}

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/** POST with success/error toast. */
export async function act<T>(url: string, body: unknown, success?: string): Promise<T | undefined> {
  try {
    const r = await api<T>(url, body);
    if (success) notifications.show({ message: success, color: "teal" });
    return r;
  } catch (e) {
    notifications.show({ title: "Action failed", message: e instanceof Error ? e.message : String(e), color: "red" });
    return undefined;
  }
}
