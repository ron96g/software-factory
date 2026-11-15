import type { CheckRun, WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { ExecutionContext, FinishValidator, ResourceReader } from "../ports/index.ts";

/** A submitted check must finish before its caller can finish and lose active-run authority. */
export class ActiveCheckFinishValidator implements FinishValidator {
  private readonly reader: ResourceReader;
  constructor(reader: ResourceReader) { this.reader = reader; }

  async validate(ctx: ExecutionContext): Promise<string[]> {
    const namespace = nsOf(ctx.workItem);
    const item = await this.reader.get<WorkItem>("WorkItem", namespace, ctx.workItem.metadata.name);
    if (!item || item.metadata.uid !== ctx.workItem.metadata.uid || !ctx.run.metadata.uid) return ["work item or caller identity changed"];
    const checks = await this.reader.list<CheckRun>("CheckRun", {
      namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
    });
    const active = checks.filter((check) => check.spec.workItemUid === item.metadata.uid &&
      check.spec.workflow?.agentRunRef?.name === ctx.run.metadata.name &&
      check.spec.workflow.agentRunUid === ctx.run.metadata.uid &&
      (!check.status || check.status.phase === "Running"));
    return active.length ? [`Checks ${active.map((check) => check.metadata.name).join(", ")} are still running; reuse their requestId to poll before finishing.`] : [];
  }
}
