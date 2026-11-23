/**
 * ADR-0062 §1/§2: an exclusive, **fenced**, store-backed lease. It is what serializes workspace work across processes:
 * a check's execution window and an agent mutation take the same lock for one (namespace, WorkItem UID). The lease is
 * fenced by `holder` + `generation`, so a stalled holder's late write or renewal is rejected, and it carries an
 * `expiresAt` from the **store's** clock, never the holder's.
 */
import type { Resource } from "../model/resource.ts";

export interface LockLease {
  /** The holder's identity (worker/web incarnation). Diagnostics, not a credential (ADR-0062 §2). */
  holder: string;
  /** Increments on every claim, so a previous holder's renew/release is rejected. */
  generation: number;
  /** ISO timestamp from the store's clock; after it the lease is reclaimable. */
  expiresAt: string;
}

export interface WorkspaceLock {
  /** Acquires the lock, or returns `undefined` when another holder has a live lease. Re-acquiring by the same holder renews. */
  acquire(key: string, holder: string, ttlMs: number): Promise<LockLease | undefined>;
  /** Extends the lease only while `holder`+`generation` still match and it has not expired. */
  renew(key: string, holder: string, generation: number, ttlMs: number): Promise<boolean>;
  /** Releases only while `holder`+`generation` still match (idempotent otherwise). */
  release(key: string, holder: string, generation: number): Promise<void>;
  /** The current live lease, or `undefined`. */
  get(key: string): Promise<LockLease | undefined>;
  /** Live (unexpired) leases, optionally only those whose key starts with `prefix` (ADR-0062 §3 concurrency limits). */
  list(prefix?: string): Promise<(LockLease & { key: string })[]>;
  /** Releases every live lock held by `holder` (ADR-0062 §2 incarnation release). Returns how many were released. */
  releaseHolder(holder: string): Promise<number>;
}

/**
 * ADR-0062 §2: kills the agent processes a previous incarnation left behind (an orphaned OpenCode or tool-loop command).
 * Returns `true` only when the processes are **confirmed gone**; a caller must not release the incarnation's locks
 * otherwise.
 */
export interface AgentProcessKiller {
  kill(holder: string): Promise<boolean>;
}

/** Identifies a held lease for a fenced write. */
export interface LeaseRef {
  key: string;
  holder: string;
  generation: number;
}

/**
 * ADR-0062 §1: a status write that is rejected unless the caller still holds its lease. A worker whose lease expired (or
 * was taken over) must not overwrite the result of the run that now owns the CheckRun.
 */
export interface FencedStatusWriter {
  /** Writes `status` only while `lease` is still live (same holder and generation); returns `null` otherwise. */
  updateStatusIf<R extends Resource>(obj: R, lease: LeaseRef): Promise<R | null>;
}
