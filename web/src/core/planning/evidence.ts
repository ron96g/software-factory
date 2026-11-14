import { createHash } from "node:crypto";
import type { AgentRun, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";

export function planningIntent(item: WorkItem): string {
  return createHash("sha256").update(JSON.stringify([
    item.metadata.uid, item.spec.title, item.spec.description, item.spec.context, item.spec.repositoryRefs,
    item.spec.originSnapshot, item.spec.planning,
  ])).digest("hex");
}

export function currentPlanningRuns(item: WorkItem, runs: AgentRun[]): AgentRun[] {
  return [...new Map(runs.filter((run) => !run.spec.replayOf && !run.metadata.labels?.[LABEL_SUPERSEDED] &&
    !run.metadata.labels?.["factory.ai-dlc.io/replay"] &&
    run.metadata.ownerReferences?.some((owner) => owner.kind === "WorkItem" && owner.uid === item.metadata.uid))
    .map((run) => [`${run.spec.stage}/${run.spec.step}`, run])).values()];
}
