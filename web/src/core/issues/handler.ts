import type { IssueProposal } from "../model/kinds.ts";
import { canCreateIssues, canFindIssues, type Lookup, type OutboxDelivery, type Redactor, type RecoverableOutboxHandler, type ResourceReader, type SourceConnector } from "../ports/index.ts";
import { issueContentHash } from "./admission.ts";

export const issueMarker = (uid: string) => `[software-factory:issue-${uid}]`;

/** ADR-0066 §3-4: `deliver` creates; `recover` only looks up and never POSTs, so an unknown outcome is never repeated blindly. */
export function createIssueHandler(d: { reader: ResourceReader; connectors: Lookup<SourceConnector>; redactor: Redactor }): RecoverableOutboxHandler {
  async function context(msg: OutboxDelivery) {
    const { namespace, proposal: name, proposalUid, contentHash } = msg.payload;
    if (typeof namespace !== "string" || typeof name !== "string" || typeof proposalUid !== "string" || typeof contentHash !== "string") throw new Error("invalid issue delivery identity");
    if (namespace !== msg.namespace) throw new Error("issue delivery cannot cross namespaces");
    const proposal = await d.reader.get<IssueProposal>("IssueProposal", namespace, name);
    if (!proposal || proposal.metadata.uid !== proposalUid) throw new Error("issue proposal is unavailable");
    const approved = proposal.status?.approved;
    if (!approved || approved.contentHash !== contentHash || issueContentHash(proposal.spec) !== contentHash) throw new Error("issue proposal changed since approval");
    if (!msg.source || proposal.spec.targetRef?.name !== msg.source.metadata.name) throw new Error("issue destination changed");
    return { proposal, approved, source: msg.source, connector: d.connectors.get(msg.source.spec.type), marker: issueMarker(proposalUid) };
  }
  return {
    action: "create-issue",
    async recover(msg) {
      const { approved, source, connector, marker } = await context(msg);
      if (!connector || !canFindIssues(connector)) throw new Error("source cannot look up issues");
      const found = await connector.findCreatedIssues(source, { marker, createdAfter: approved.at });
      if (found.length !== 1) throw new Error(`${found.length} matching issues found after interrupted delivery; outcome is unknown`);
      return { ...found[0] };
    },
    async deliver(msg) {
      const { proposal, source, connector, marker } = await context(msg);
      if (!connector || !canCreateIssues(connector)) throw new Error("source cannot create issues");
      const cfg = source.spec.writeBack?.issues;
      const labels = [...(proposal.spec.labels ?? []), ...(proposal.spec.pickUp ? (cfg?.pickUpLabels ?? []) : [])].map((l) => d.redactor.redact(l));
      const created = await connector.createIssue(source, {
        title: d.redactor.redact(proposal.spec.title), body: d.redactor.redact(proposal.spec.body),
        issueType: proposal.spec.issueType, labels, marker,
      });
      return { ...created };
    },
  };
}
