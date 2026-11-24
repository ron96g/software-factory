import type { AgentRun, Approval, Artifact, IssueProposal, Source, WorkItem } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { API_VERSION, SYSTEM_NAMESPACE } from "../model/resource.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import type { Clock, CompiledStage, PublicationProgress, Redactor, ResourceReader, ResourceWriter, StagePublisher } from "../ports/index.ts";
import { isStoreError } from "../ports/index.ts";
import { LABEL_REPLAY } from "../agents/replayer.ts";
import { issueContentHash } from "./admission.ts";
import { renderFollowUpTicketBody } from "./followup-body.ts";

export const storyTicketName = (workItem: string) => `${workItem}-ticket`;
const MAX_TITLE = 200;

/** The `ticket-draft` artifact contract (artifacts/ticket-draft.yaml). */
export function parseTicketDraft(content: string): { title: string; body: string } | null {
  try {
    const v = JSON.parse(content) as { title?: unknown; body?: unknown };
    return typeof v.title === "string" && v.title.trim() && typeof v.body === "string" && v.body.trim() ? { title: v.title.trim(), body: v.body.trim() } : null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

const newest = <T extends { metadata: { creationTimestamp?: string } }>(list: T[]) =>
  [...list].sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))[0];

/**
 * ADR-0084 `publish.issue`: one ticket per item from the draft the human approved at `reviewStage`. Created Approved on
 * the approver's behalf (rule 8), bound to the Approval and the exact artifact version; delivery is ADR-0066's.
 */
export function storyPublisher(d: { reader: ResourceReader; writer: ResourceWriter; redactor: Redactor; clock: Clock; factoryUrl?: string }): StagePublisher {
  return {
    async publish(wi: WorkItem, stage: CompiledStage): Promise<PublicationProgress> {
      const cfg = stage.publish?.issue;
      if (!cfg) return { state: "published" };
      const ns = nsOf(wi);
      const owned = { namespace: ns, ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: ns } };
      const name = storyTicketName(wi.metadata.name);
      const existing = await d.reader.get<IssueProposal>("IssueProposal", ns, name);

      const approval = newest((await d.reader.list<Approval>("Approval", owned))
        .filter((a) => a.spec.stage === cfg.reviewStage && a.spec.decision === "approve" && !a.metadata.labels?.[LABEL_SUPERSEDED]));
      if (!approval) {
        // A created ticket stays published even if its approval was superseded later (e.g. by a restart).
        if (existing?.status?.phase === "Created") return { state: "published", message: `ticket ${existing.status.externalRef?.externalId ?? name} created` };
        return { state: "blocked", reason: `no approved ${cfg.reviewStage} decision to publish` };
      }
      const runs = await d.reader.list<AgentRun>("AgentRun", owned);
      const stale = new Set(runs.filter((r) => r.spec.replayOf || r.metadata.labels?.[LABEL_REPLAY] || r.metadata.labels?.[LABEL_SUPERSEDED]).map((r) => r.metadata.name));
      const approvedAt = approval.metadata.creationTimestamp ?? "";
      const artifact = newest((await d.reader.list<Artifact>("Artifact", owned)).filter((a) =>
        a.spec.artifactTypeRef.name === cfg.artifactRef.name && !a.metadata.labels?.[LABEL_REPLAY] && !a.metadata.labels?.[LABEL_SUPERSEDED] &&
        !stale.has(a.spec.producedBy?.agentRunRef.name ?? "") && (a.metadata.creationTimestamp ?? "") <= approvedAt));
      if (!artifact?.metadata.uid || !artifact.metadata.resourceVersion) return { state: "blocked", reason: `no ${cfg.artifactRef.name} was approved at ${cfg.reviewStage}` };

      if (existing) {
        if (existing.spec.provenance?.artifact?.uid !== artifact.metadata.uid) {
          const ref = existing.status?.externalRef?.externalId;
          return { state: "blocked", reason: `this item already published ${ref ?? `ticket ${name}`}; the factory never edits a created ticket. Update it in the tracker, or create a new item.` };
        }
        const phase = existing.status?.phase;
        if (phase === "Created") return { state: "published", message: `ticket ${existing.status?.externalRef?.externalId ?? name} created` };
        if (phase === "Uncertain" || phase === "Failed") {
          return { state: "blocked", reason: `creating the ticket is ${phase.toLowerCase()}: ${existing.status?.conditions?.find((c) => c.type === "Created")?.message ?? "see the Issues panel"}. Retry or link the existing ticket on the item's Issues panel.` };
        }
        return { state: "pending" };
      }

      const target = wi.spec.ticketTarget ?? cfg.targetRef;
      if (!target) return { state: "blocked", reason: "no tracker to publish to: set the item's ticket target" };
      const source = await d.reader.get<Source>("Source", SYSTEM_NAMESPACE, target.name) ?? await d.reader.get<Source>("Source", ns, target.name);
      if (!source?.spec.writeBack?.issues) return { state: "blocked", reason: `source "${target.name}" does not permit creating issues` };
      const draft = parseTicketDraft(artifact.spec.content);
      if (!draft) return { state: "blocked", reason: `${artifact.metadata.name} is not a valid ${cfg.artifactRef.name} (title and body)` };

      const r = d.redactor;
      const spec: IssueProposal["spec"] = {
        purpose: "story",
        targetRef: { name: target.name },
        title: r.redact(draft.title).slice(0, MAX_TITLE),
        body: r.redact(renderFollowUpTicketBody({ body: draft.body, originUrl: wi.spec.externalRef?.url, originName: wi.metadata.name, factoryUrl: d.factoryUrl })),
        issueType: source.spec.writeBack.issues.issueType,
        pickUp: false,
        provenance: {
          human: true, proposedBy: approval.spec.decidedBy, workItem: wi.metadata.name, proposedAt: d.clock.now().toISOString(), approval: approval.metadata.name,
          artifact: { name: artifact.metadata.name, uid: artifact.metadata.uid, resourceVersion: artifact.metadata.resourceVersion },
        },
      };
      try {
        await d.writer.create<IssueProposal>({
          apiVersion: API_VERSION, kind: "IssueProposal",
          metadata: { name, namespace: ns, ownerReferences: [ownerRef(wi)] },
          spec: { ...spec, review: { decision: "approve", by: approval.spec.decidedBy, at: approvedAt, contentHash: issueContentHash(spec) } },
        });
      } catch (e) {
        if (!isStoreError(e, "AlreadyExists")) throw e;
      }
      return { state: "pending" };
    },
  };
}
