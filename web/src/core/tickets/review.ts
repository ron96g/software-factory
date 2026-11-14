import type { AgentRun, Approval, Artifact, Source, TicketPublication, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { Redactor, ResourceReader, SourceConnector, TicketStateReader, ServiceDeskCommentPublisher, ServiceDeskCommentFinder, TicketTransitionWriter } from "../ports/index.ts";
import { StoreError } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

export async function ticketItem(reader: ResourceReader, namespace: string, name: string) {
  const item = await reader.get<WorkItem>("WorkItem", namespace, name);
  if (!item) throw new StoreError(`work item ${name} not found`, "NotFound");
  if (!item.spec.externalRef?.id || !item.metadata.uid) throw new Error("this item has no external ticket identity");
  const source = await resolveRef<Source>(reader, "Source", item.spec.sourceRef, namespace);
  if (!source) throw new Error("ticket source is unavailable");
  return { item, source, externalId: item.spec.externalRef.id };
}

export function hasTicketState(c: SourceConnector | undefined): c is SourceConnector & TicketStateReader {
  return typeof (c as Partial<TicketStateReader> | undefined)?.ticketState === "function";
}
export function hasReplyWriter(c: SourceConnector | undefined): c is SourceConnector & ServiceDeskCommentPublisher & ServiceDeskCommentFinder {
  const p = c as Partial<ServiceDeskCommentPublisher & ServiceDeskCommentFinder> | undefined;
  return typeof p?.publishReply === "function" && typeof p.findReply === "function";
}
export function hasTransitionWriter(c: SourceConnector | undefined): c is SourceConnector & TicketStateReader & TicketTransitionWriter {
  return hasTicketState(c) && typeof (c as Partial<TicketTransitionWriter>).transitionTicket === "function";
}

export async function publicationProposal(reader: ResourceReader, redactor: Redactor, item: WorkItem, artifactType: string, reviewStage: string): Promise<TicketPublication> {
  const ns = nsOf(item), ownedBy = { kind: "WorkItem", name: item.metadata.name, namespace: ns };
  const prior = await reader.get<Approval>("Approval", ns, `${item.metadata.name}-${reviewStage}-r${(item.status?.round ?? 0) - 1}`);
  if (prior?.spec.decision !== "approve" || prior.metadata.labels?.[LABEL_SUPERSEDED]) throw new StoreError("a current response review must be approved before publication", "Invalid");
  const runs = await reader.list<AgentRun>("AgentRun", { namespace: ns, ownedBy });
  const ineligible = new Set(runs.filter((r) => r.spec.replayOf || r.metadata.labels?.[LABEL_SUPERSEDED] || r.metadata.labels?.["factory.ai-dlc.io/replay"]).map((r) => r.metadata.name));
  const artifacts = await reader.list<Artifact>("Artifact", { namespace: ns, ownedBy });
  const artifact = artifacts.filter((a) => a.spec.artifactTypeRef.name === artifactType && !a.metadata.labels?.[LABEL_SUPERSEDED] && !a.metadata.labels?.["factory.ai-dlc.io/replay"] && !ineligible.has(a.spec.producedBy?.agentRunRef.name ?? ""))
    .sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? "")).at(-1);
  if (!artifact?.metadata.uid || !artifact.metadata.resourceVersion || !artifact.spec.content.trim()) throw new StoreError("no current nonempty response artifact is available", "Invalid");
  if (!item.metadata.uid || !item.spec.externalRef?.id) throw new StoreError("work item has no external ticket identity", "Invalid");
  const source = await resolveRef<Source>(reader, "Source", item.spec.sourceRef, ns);
  if (!source?.metadata.resourceVersion) throw new StoreError("publication source has no persisted version", "Invalid");
  return {
    workItemUid: item.metadata.uid, source: item.spec.sourceRef.name, sourceVersion: source.metadata.resourceVersion, externalId: item.spec.externalRef.id,
    artifact: { name: artifact.metadata.name, uid: artifact.metadata.uid, version: artifact.metadata.resourceVersion },
    body: redactor.redact(artifact.spec.content),
  };
}

export async function validatePublication(reader: ResourceReader, redactor: Redactor, item: WorkItem, approval: Approval) {
  const proposal = approval.spec.ticketPublication;
  if (!proposal || proposal.workItemUid !== item.metadata.uid || proposal.source !== item.spec.sourceRef.name || proposal.externalId !== item.spec.externalRef?.id) throw new StoreError("publication ticket identity changed", "Conflict");
  const source = await resolveRef<Source>(reader, "Source", item.spec.sourceRef, nsOf(item));
  if (source?.metadata.resourceVersion !== proposal.sourceVersion) throw new StoreError("publication source configuration changed; start a fresh review", "Conflict");
  if (item.status?.blockedBy?.name !== approval.metadata.name || item.status.phase !== "AwaitingApproval" || approval.spec.stage !== item.status.stage) throw new Error("publication approval is no longer the current gate");
  const artifact = await reader.get<Artifact>("Artifact", nsOf(item), proposal.artifact.name);
  const run = artifact?.spec.producedBy?.agentRunRef ? await reader.get<AgentRun>("AgentRun", nsOf(item), artifact.spec.producedBy.agentRunRef.name) : null;
  if (!artifact || artifact.metadata.uid !== proposal.artifact.uid || artifact.metadata.resourceVersion !== proposal.artifact.version ||
      artifact.spec.workItemRef.name !== item.metadata.name || artifact.metadata.labels?.[LABEL_SUPERSEDED] || artifact.metadata.labels?.["factory.ai-dlc.io/replay"] ||
      run?.spec.replayOf || run?.metadata.labels?.[LABEL_SUPERSEDED] || run?.metadata.labels?.["factory.ai-dlc.io/replay"] || redactor.redact(artifact.spec.content) !== proposal.body) {
    throw new StoreError("response evidence changed; reject this publication and review the new response", "Conflict");
  }
  return proposal;
}
