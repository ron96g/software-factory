import type { CheckRun, WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { StoreError, type ExecutionContext, type LockLease, type ResourceReader, type WorkspaceJobCoordinator, type WorkspaceLock } from "../ports/index.ts";

/** Single-process workspace lock; check creation and mutations hold the same lock through completion. */
export class SerializedWorkspaceJobs implements WorkspaceJobCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly reader: ResourceReader;

  constructor(reader: ResourceReader) { this.reader = reader; }

  private async locked<T>(item: WorkItem, operation: () => Promise<T>): Promise<T> {
    if (!item.metadata.uid) throw new StoreError("work item UID is required for workspace coordination", "Invalid");
    const key = `${nsOf(item)}/${item.metadata.uid}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async mutate<T>(ctx: ExecutionContext, operation: () => Promise<T>): Promise<T> {
    return this.locked(ctx.workItem, async () => {
      const item = await this.reader.get<WorkItem>("WorkItem", nsOf(ctx.workItem), ctx.workItem.metadata.name);
      if (!item || item.metadata.uid !== ctx.workItem.metadata.uid) throw new StoreError("work item identity changed", "Conflict");
      const checks = await this.reader.list<CheckRun>("CheckRun", {
        namespace: nsOf(item), ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) },
      });
      if (checks.some((check) => check.spec.workItemUid === item.metadata.uid &&
          (!check.status || check.status.phase === "Running"))) {
        throw new StoreError("a workspace check is pending or running; wait for its result before modifying the workspace", "Conflict");
      }
      return operation();
    });
  }

  async submit<T>(item: WorkItem, operation: () => Promise<T>): Promise<T> {
    return this.locked(item, operation);
  }
}

/**
 * ADR-0062 §1: the workspace coordinator backed by the store lock. It keeps the in-process serialization (a fast path)
 * and adds **cross-process** exclusion through the fenced `WorkspaceLock`: a check's execution window and an agent
 * mutation for the same (namespace, WorkItem UID) cannot overlap across processes. A lock held by another holder is a
 * `Conflict`, never a wait (rule 6).
 */
export class StoreWorkspaceJobs implements WorkspaceJobCoordinator {
  private readonly reader: ResourceReader;
  private readonly lock: WorkspaceLock;
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new Map<string, LockLease>();

  constructor(d: { reader: ResourceReader; lock: WorkspaceLock; holder: string; ttlMs?: number }) {
    this.reader = d.reader;
    this.lock = d.lock;
    this.holder = d.holder;
    this.ttlMs = d.ttlMs ?? 60_000;
  }

  private keyOf(item: WorkItem): string {
    if (!item.metadata.uid) throw new StoreError("work item UID is required for workspace coordination", "Invalid");
    return `${nsOf(item)}/${item.metadata.uid}`;
  }

  private async locked<T>(item: WorkItem, operation: () => Promise<T>): Promise<T> {
    const key = this.keyOf(item);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    const reentrant = this.held.has(key);
    const lease = reentrant ? undefined : await this.lock.acquire(key, this.holder, this.ttlMs);
    if (!reentrant && !lease) {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
      throw new StoreError("the workspace is locked by another process; try again", "Conflict");
    }
    if (lease) this.held.set(key, lease);
    try {
      return await operation();
    } finally {
      if (lease) {
        this.held.delete(key);
        await this.lock.release(key, this.holder, lease.generation);
      }
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async mutate<T>(ctx: ExecutionContext, operation: () => Promise<T>): Promise<T> {
    return this.locked(ctx.workItem, async () => {
      const item = await this.reader.get<WorkItem>("WorkItem", nsOf(ctx.workItem), ctx.workItem.metadata.name);
      if (!item || item.metadata.uid !== ctx.workItem.metadata.uid) throw new StoreError("work item identity changed", "Conflict");
      const checks = await this.reader.list<CheckRun>("CheckRun", {
        namespace: nsOf(item), ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) },
      });
      if (checks.some((check) => check.spec.workItemUid === item.metadata.uid &&
          (!check.status || check.status.phase === "Running"))) {
        throw new StoreError("a workspace check is pending or running; wait for its result before modifying the workspace", "Conflict");
      }
      return operation();
    });
  }

  async submit<T>(item: WorkItem, operation: () => Promise<T>): Promise<T> {
    return this.locked(item, operation);
  }
}
