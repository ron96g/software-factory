import type { AgentRun, Approval, Artifact, Clarification, FactoryEvent, WorkItem } from "../model/kinds.ts";
import type { ResourceReader, WorkItemRecord, WorkItemRecordReader } from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";

export class DefaultWorkItemRecordReader implements WorkItemRecordReader {
  private readonly reader: ResourceReader;
  constructor(reader: ResourceReader) { this.reader = reader; }

  async read(namespace: string, name: string): Promise<WorkItemRecord> {
    const workItem = await this.reader.get<WorkItem>("WorkItem", namespace, name);
    if (!workItem) throw new Error(`work item ${name} not found`);
    const ownedBy = { kind: "WorkItem", name, namespace };
    const [runs, artifacts, clarifications, approvals, events] = await Promise.all([
      this.reader.list<AgentRun>("AgentRun", { namespace, ownedBy }),
      this.reader.list<Artifact>("Artifact", { namespace, ownedBy }),
      this.reader.list<Clarification>("Clarification", { namespace, ownedBy }),
      this.reader.list<Approval>("Approval", { namespace, ownedBy }),
      this.reader.list<FactoryEvent>("Event", { namespace, labelSelector: { [LABEL_WORKITEM]: name } }),
    ]);
    return { workItem, runs, artifacts, clarifications, approvals, events };
  }
}
