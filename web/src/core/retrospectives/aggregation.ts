import type { AgentRun, RetrospectiveFeedback, RetrospectivePolicy, WorkItem } from "../model/kinds.ts";
import type { Clock, ResourceReader, RetrospectiveAggregation, RetrospectiveGroup } from "../ports/index.ts";
import { fingerprint } from "../app/work-item-followups.ts";
import { exclusions, feedbackIdentity, groupId, support } from "./evidence.ts";

export class DefaultRetrospectiveAggregation implements RetrospectiveAggregation {
  private readonly reader: ResourceReader;
  private readonly clock: Clock;
  private readonly policy: RetrospectivePolicy;
  constructor(reader: ResourceReader, clock: Clock, policy: RetrospectivePolicy) {
    this.reader = reader; this.clock = clock; this.policy = structuredClone(policy);
    if (!policy.version || !policy.issueCodes.length || new Set(policy.issueCodes).size !== policy.issueCodes.length ||
      policy.issueCodes.some((c) => !/^[a-z][a-z0-9-]{0,79}$/.test(c)) ||
      ![policy.minimumOrigins, policy.minimumRoles, policy.windowDays].every((v) => Number.isInteger(v) && v > 0) ||
      policy.minimumOrigins > 12 || policy.minimumRoles > 12 || policy.windowDays > 365) throw new Error("Invalid retrospective support policy");
  }

  async groups(namespace: string): Promise<RetrospectiveGroup[]> {
    const [feedback, runs, items] = await Promise.all([
      this.reader.list<RetrospectiveFeedback>("RetrospectiveFeedback", { namespace }),
      this.reader.list<AgentRun>("AgentRun", { namespace }),
      this.reader.list<WorkItem>("WorkItem", { namespace }),
    ]);
    const runMap = new Map(runs.map((r) => [r.metadata.name, r]));
    const itemMap = new Map(items.map((r) => [r.metadata.name, r]));
    const groups = new Map<string, RetrospectiveGroup>();
    for (const f of feedback.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
      const id = groupId(f);
      let group = groups.get(id);
      if (!group) {
        group = { id, revision: "", target: f.spec.target, issueCode: f.spec.review?.issueCode ?? f.spec.observation.issueCode,
          policy: this.policy, reports: [], origins: 0, roles: [], thresholdMet: false,
          investigations: items.filter((w) => w.spec.retrospective?.group === id) };
        groups.set(id, group);
      }
      const run = runMap.get(f.spec.origin.agentRun), item = itemMap.get(f.spec.origin.workItem);
      const reasons = exclusions(f, this.policy, run, item, this.clock.now().getTime());
      group.reports.push({ feedback: f, eligible: !reasons.length, exclusions: reasons,
        originAvailable: run?.metadata.uid === f.spec.origin.agentRunUid && item?.metadata.uid === f.spec.origin.workItemUid });
    }
    for (const g of groups.values()) {
      Object.assign(g, support(g.reports));
      g.thresholdMet = g.origins >= g.policy.minimumOrigins && g.roles.length >= g.policy.minimumRoles;
      g.revision = fingerprint([g.policy, g.reports.map((r) => [feedbackIdentity(r.feedback), r.exclusions])]);
    }
    return [...groups.values()];
  }
}
