import type { RetrospectiveFeedback, RetrospectiveSnapshot, WorkItem } from "../model/kinds.ts";
import { API_VERSION } from "../model/resource.ts";
import { setCondition } from "../model/meta.ts";
import { isStoreError, type Clock, type ResourceReader, type ResourceWriter, type RetrospectiveAggregation,
  type RetrospectiveInvestigator, type StatusWriter } from "../ports/index.ts";
import { feedbackIdentity, RETROSPECTIVE_WORKFLOW, support } from "./evidence.ts";

export class DefaultRetrospectiveInvestigator implements RetrospectiveInvestigator {
  private readonly d: {
    reader: ResourceReader; writer: ResourceWriter; status: StatusWriter; aggregation: RetrospectiveAggregation; clock: Clock;
  };
  constructor(d: DefaultRetrospectiveInvestigator["d"]) { this.d = d; }

  async reconcile(namespace: string) {
    for (const group of await this.d.aggregation.groups(namespace)) {
      const histories = group.reports.flatMap((r) => r.feedback.status?.investigations ?? []);
      const requests = group.reports.flatMap((r) => r.feedback.spec.investigationRequest ? [r.feedback.spec.investigationRequest] : []);
      const pending = requests.find((request) => !histories.some((h) => h.cycle === request.id) &&
        !group.investigations.some((i) => i.spec.retrospective?.cycle === request.id));
      const hasHistory = histories.length > 0 || group.investigations.length > 0;
      const cycle = pending?.id ?? (!hasHistory && group.thresholdMet ? "auto" : undefined);
      if (cycle) {
        // Select distinct origins/roles first so repeated reports cannot crowd corroborating evidence out.
        const selected: typeof group.reports = [];
        const origins = new Set<string>(), roles = new Set<string>();
        for (const r of group.reports.filter((r) => r.eligible)) {
          if (!origins.has(r.feedback.spec.origin.workItemUid) || !roles.has(r.feedback.spec.reporter.role)) {
            selected.push(r); origins.add(r.feedback.spec.origin.workItemUid); roles.add(r.feedback.spec.reporter.role);
          }
        }
        selected.push(...group.reports.filter((r) => !selected.includes(r)));
        const bounded = selected.slice(0, 12);
        const counts = support(bounded);
        if (cycle === "auto" && (counts.origins < group.policy.minimumOrigins || counts.roles.length < group.policy.minimumRoles)) {
          throw new Error("Bounded retrospective evidence cannot satisfy support policy; start a human investigation.");
        }
        const snapshot: RetrospectiveSnapshot = {
          group: group.id, cycle, capturedAt: this.d.clock.now().toISOString(), revision: group.revision, policy: group.policy,
          ...counts, truncated: selected.length > bounded.length,
          reports: bounded.map((r) => ({ name: r.feedback.metadata.name, uid: r.feedback.metadata.uid!,
            fingerprint: feedbackIdentity(r.feedback), eligible: r.eligible, exclusions: r.exclusions, spec: r.feedback.spec })),
        };
        const name = `retrospective-${group.id}-${cycle}`;
        try {
          const created = await this.d.writer.create<WorkItem>({
            apiVersion: API_VERSION, kind: "WorkItem", metadata: { name, namespace },
            spec: { title: `Investigate ${group.issueCode}: ${group.target.name}/${group.target.stage}`,
              description: "Investigate the evidence. Propose a change only when justified; no change is a valid conclusion.",
              workflowRef: { name: RETROSPECTIVE_WORKFLOW }, sourceRef: { name: "retrospective" },
              repositoryRefs: [], publicationDisabled: true, retrospective: snapshot },
          });
          group.investigations.push(created);
        } catch (e) {
          if (!isStoreError(e, "AlreadyExists")) throw e;
          const existing = await this.d.reader.get<WorkItem>("WorkItem", namespace, name);
          if (!existing?.spec.retrospective || existing.spec.retrospective.group !== group.id || existing.spec.retrospective.cycle !== cycle) {
            throw new Error("Retrospective investigation name is occupied by a different item");
          }
          group.investigations.push(existing);
        }
      }
      for (const r of group.reports) {
        const f = r.feedback;
        const links = [...(f.status?.investigations ?? [])];
        for (const item of group.investigations) {
          if (!links.some((link) => link.name === item.metadata.name)) {
            links.push({ name: item.metadata.name, uid: item.metadata.uid!, cycle: item.spec.retrospective!.cycle });
          }
        }
        const phase = links.length ? "Investigating" : r.eligible ? "Eligible" : "Observed";
        if (f.status?.phase === phase && JSON.stringify(f.status.exclusions) === JSON.stringify(r.exclusions) &&
          JSON.stringify(f.status.investigations) === JSON.stringify(links)) continue;
        await this.d.status.updateStatus<RetrospectiveFeedback>({ ...f, status: {
          phase, exclusions: r.exclusions, investigations: links,
          conditions: setCondition(f.status?.conditions, "Eligible", r.eligible ? "True" : "False",
            r.eligible ? "EligibleSupport" : "Excluded", r.exclusions.join("; "), this.d.clock.now()),
        } });
      }
    }
  }
}
