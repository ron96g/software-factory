import { ownerOf, ownerRef, nsOf } from "../model/meta.ts";
import type { FactoryEvent } from "../model/kinds.ts";
import { API_VERSION, type Resource } from "../model/resource.ts";
import type { EventRecorder, ResourceWriter } from "../ports/index.ts";

export const LABEL_WORKITEM = "factory.ai-dlc.io/workitem";

/** Persists Kubernetes-style Event resources (audit trail / UI timeline). Owned by the involved object. */
export class StoreEventRecorder implements EventRecorder {
  private readonly writer: ResourceWriter;
  constructor(writer: ResourceWriter) {
    this.writer = writer;
  }
  normal(involved: Resource, reason: string, message: string) {
    return this.record(involved, "Normal", reason, message);
  }
  warning(involved: Resource, reason: string, message: string) {
    return this.record(involved, "Warning", reason, message);
  }
  private async record(involved: Resource, type: "Normal" | "Warning", reason: string, message: string) {
    const workItem = involved.kind === "WorkItem" ? involved.metadata.name : ownerOf(involved, "WorkItem")?.name;
    const ev: FactoryEvent = {
      apiVersion: API_VERSION,
      kind: "Event",
      metadata: {
        name: "",
        generateName: "evt-",
        namespace: nsOf(involved),
        labels: workItem ? { [LABEL_WORKITEM]: workItem } : {},
        ownerReferences: involved.metadata.uid?.startsWith("def-") ? [] : [ownerRef(involved)],
      },
      spec: {
        involvedObject: { kind: involved.kind, name: involved.metadata.name, uid: involved.metadata.uid },
        type,
        reason,
        message,
      },
    };
    await this.writer.create(ev);
  }
}
