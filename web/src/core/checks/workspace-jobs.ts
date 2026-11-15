import type { CheckRun, WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { StoreError, type ExecutionContext, type ResourceReader, type WorkspaceJobCoordinator } from "../ports/index.ts";

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
