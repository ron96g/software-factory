import type { LeaseRef, WorkspaceLock } from "../ports/index.ts";

/** ADR-0062 §3: the lease key prefix a live check worker announces itself with. */
export const WORKER_LEASE_PREFIX = "worker/";

/**
 * ADR-0062 §3: a process that can execute checks holds a long-lived `worker/<incarnation>` lease, renewed on a timer.
 *
 * A `checkrun/…` lease only exists while a check runs, so counting those cannot tell an idle worker from an absent one.
 * This heartbeat is what makes "will a Pending check ever be picked up?" answerable (`SystemHealth.checks.workers`).
 */
export class WorkerHeartbeat {
  private readonly lock: WorkspaceLock;
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly onError: (message: string) => void;
  private lease?: LeaseRef;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(o: { lock: WorkspaceLock; holder: string; ttlMs?: number; onError?: (message: string) => void }) {
    this.lock = o.lock;
    this.holder = o.holder;
    this.ttlMs = o.ttlMs ?? 30_000;
    this.onError = o.onError ?? (() => {});
  }

  /** The lease this process announces itself with. */
  get key(): string {
    return `${WORKER_LEASE_PREFIX}${this.holder}`;
  }

  /** Announces this process and keeps the announcement alive. Idempotent. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    // A store that is briefly unavailable must not take the worker down: the next beat retries.
    await this.beat().catch((error) => this.onError(`worker heartbeat could not be registered: ${reason(error)}`));
    // ADR-0062 §2: the lease expires from the store's clock, so renew well inside the TTL (never from our own clock).
    this.timer = setInterval(() => void this.beat().catch((error) => this.onError(`worker heartbeat failed: ${reason(error)}`)), Math.max(1000, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.();
  }

  /** Withdraws the announcement (a clean shutdown must not leave a worker looking alive until its TTL). Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (!lease) return;
    try {
      await this.lock.release(lease.key, lease.holder, lease.generation);
    } catch (error) {
      // Shutdown continues: a lease that cannot be withdrawn expires with its TTL.
      this.onError(`worker heartbeat could not be withdrawn: ${reason(error)}`);
    }
  }

  private async beat(): Promise<void> {
    if (this.stopped) return; // a beat already in flight must not re-announce a stopped worker
    const lease = this.lease;
    if (lease && (await this.lock.renew(lease.key, lease.holder, lease.generation, this.ttlMs))) return;
    const fresh = await this.lock.acquire(this.key, this.holder, this.ttlMs);
    if (!fresh) {
      // Defensive: the key embeds the holder, so only a live lease with this exact identity can block us. Retry next beat.
      this.onError(`worker heartbeat ${this.key} is not registered; retrying`);
      this.lease = undefined;
      return;
    }
    this.lease = { key: this.key, holder: this.holder, generation: fresh.generation };
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
