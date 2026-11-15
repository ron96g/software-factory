import type { AgentRun, Artifact, CheckRun, UnitAssignment, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { ResourceReader, UnitAttemptReader } from "../ports/index.ts";

export class CompletedUnitAttempts implements UnitAttemptReader {
  private readonly reader: ResourceReader;
  constructor(reader: ResourceReader) { this.reader = reader; }

  async completed(item: WorkItem, assignment: UnitAssignment, currentRun: string) {
    const selector = { namespace: nsOf(item), ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) } };
    const eligible = (resource: AgentRun | Artifact | CheckRun) => !resource.metadata.labels?.["factory.ai-dlc.io/replay"] &&
      !resource.metadata.labels?.[LABEL_SUPERSEDED] && resource.metadata.ownerReferences?.some((owner) => owner.uid === item.metadata.uid);
    const runs = (await this.reader.list<AgentRun>("AgentRun", selector)).filter((run) =>
      eligible(run) && !run.spec.replayOf && run.metadata.name !== currentRun &&
      ["Succeeded", "Failed"].includes(run.status?.phase ?? "") &&
      run.spec.assignment?.planFingerprint === assignment.planFingerprint && run.spec.assignment.kind === assignment.kind &&
      (assignment.kind !== "unit" || (run.spec.assignment.kind === "unit" && run.spec.assignment.unit === assignment.unit)))
      .sort((a, b) => Number(/-r(\d+)$/.exec(a.metadata.name)?.[1] ?? 0) - Number(/-r(\d+)$/.exec(b.metadata.name)?.[1] ?? 0));
    const artifacts = (await this.reader.list<Artifact>("Artifact", selector)).filter(eligible);
    const checks = (await this.reader.list<CheckRun>("CheckRun", selector)).filter((check) =>
      eligible(check) && check.spec.workItemUid === item.metadata.uid && check.spec.workflow?.planFingerprint === assignment.planFingerprint);
    return runs.map((run) => {
      const result = artifacts.find((artifact) => artifact.spec.producedBy?.agentRunRef.name === run.metadata.name &&
        artifact.spec.artifactTypeRef.name === "unit-result");
      const report = artifacts.find((artifact) => artifact.spec.producedBy?.agentRunRef.name === run.metadata.name &&
        artifact.spec.artifactTypeRef.name === "recovery-report");
      return {
        run: run.metadata.name, uid: run.metadata.uid!, resourceVersion: run.metadata.resourceVersion!,
        outcome: run.status?.result?.outcome,
        summary: run.status?.result?.summary ?? run.status?.message,
        result: result && { name: result.metadata.name, resourceVersion: result.metadata.resourceVersion!, content: result.spec.content },
        report: report && { name: report.metadata.name, resourceVersion: report.metadata.resourceVersion!, content: report.spec.content },
        checks: checks.filter((check) => check.spec.workflow?.unitRun === run.metadata.name ||
          check.spec.workflow?.agentRunUid === run.metadata.uid).map((check) => ({
          name: check.metadata.name, resourceVersion: check.metadata.resourceVersion!, check: check.spec.check,
          outcome: check.status?.outcome, snapshot: check.spec.snapshot, logRef: check.status?.logRef,
        })),
      };
    });
  }
}
