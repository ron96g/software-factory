import type { Resource } from "../model/resource.ts";
import type { FencedStatusWriter, LeaseRef, StatusWriter, WorkspaceLock } from "../ports/index.ts";

/**
 * ADR-0062 §1: a status write that is rejected unless the caller still holds its lease. The check and the write are two
 * statements against the same database; the window between them is bounded by the lease TTL, which is what a stale
 * holder would have to race to overwrite the result of the run that now owns the object.
 */
export class SqliteFencedStatusWriter implements FencedStatusWriter {
  private readonly status: StatusWriter;
  private readonly lock: WorkspaceLock;

  constructor(status: StatusWriter, lock: WorkspaceLock) {
    this.status = status;
    this.lock = lock;
  }

  async updateStatusIf<R extends Resource>(obj: R, lease: LeaseRef): Promise<R | null> {
    const live = await this.lock.get(lease.key);
    if (!live || live.holder !== lease.holder || live.generation !== lease.generation) return null;
    return this.status.updateStatus(obj);
  }
}
