import type { Approval, OutboxMessage, TicketTransition } from "../model/kinds.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import type { ApprovalGateEvaluator, GateEvaluator, GateDecision, Lookup, Outbox, OutboxDelivery, RecoverableOutboxHandler, Redactor, ResourceReader, SourceConnector } from "../ports/index.ts";
import { fingerprint } from "../app/work-item-followups.ts";
import { routeToDecision } from "../model/routes.ts";
import { isStoreError } from "../ports/index.ts";
import { hasReplyWriter, hasTransitionWriter, publicationProposal, ticketItem, validatePublication } from "./review.ts";

export const replyKey = (approval: Approval) => {
  if (!approval.metadata.uid) throw new Error("publication approval has no persisted identity");
  return `ticket-reply-${approval.metadata.uid}`;
};
export const stateKey = (approval: Approval) => `${replyKey(approval)}-state`;
const marker = (approval: Approval) => `[software-factory:${replyKey(approval)}]`;

export function ticketPublicationGate(d: { reader: ResourceReader; outbox: Outbox; redactor: Redactor }): GateEvaluator & ApprovalGateEvaluator {
  return {
    type: "ticket-publication",
    async evaluate({ workItem, gate }) {
      if (!gate.publication) return { action: "fail", reason: "publication gate has no artifact/review-stage configuration" };
      try {
        return { action: "await-approval", ticketPublication: await publicationProposal(d.reader, d.redactor, workItem, gate.publication.artifactRef.name, gate.publication.reviewStage) };
      } catch (e) {
        if (!isStoreError(e, "Invalid")) throw e;
        return { action: "fail", reason: e.message };
      }
    },
    async evaluateApproval({ workItem, gate }, approval) {
      if (approval.spec.decision === "reject") return routeToDecision<GateDecision>(gate.onReject, { action: "end", phase: "Closed", reason: "publication rejected" });
      if (approval.spec.decision !== "approve") return { action: "await-approval" };
      let proposal;
      try { proposal = await validatePublication(d.reader, d.redactor, workItem, approval); }
      catch (e) {
        if (!isStoreError(e, "Conflict")) throw e;
        return { action: "fail", reason: e.message };
      }
      if (!proposal.reviewed) return { action: "fail", reason: "publication lacks an explicit human visibility review" };
      const namespace = nsOf(workItem);
      const payload = { namespace, workItem: workItem.metadata.name, workItemUid: workItem.metadata.uid, sourceVersion: proposal.sourceVersion, approval: approval.metadata.name, approvalUid: approval.metadata.uid, reviewHash: fingerprint(proposal) };
      await d.outbox.enqueue({ key: replyKey(approval), namespace, source: proposal.source, externalId: proposal.externalId, action: "service-desk-reply", payload, owner: ownerRef(workItem) });
      const reply = await d.reader.get<OutboxMessage>("OutboxMessage", namespace, replyKey(approval));
      if (reply?.status?.phase === "Failed") return { action: "fail", reason: `Jira reply failed: ${reply.status.lastError}` };
      if (reply?.status?.phase !== "Delivered") return { action: "wait", retryAfterMs: 1000 };
      if (!proposal.reviewed.transition) return { action: "advance" };
      await d.outbox.enqueue({ key: stateKey(approval), namespace, source: proposal.source, externalId: proposal.externalId, action: "ticket-transition", payload, owner: ownerRef(workItem) });
      const state = await d.reader.get<OutboxMessage>("OutboxMessage", namespace, stateKey(approval));
      if (state?.status?.phase === "Failed") return { action: "fail", reason: `Reply was published, but Jira status change failed: ${state.status.lastError}` };
      return state?.status?.phase === "Delivered" ? { action: "advance" } : { action: "wait", retryAfterMs: 1000 };
    },
  };
}

function isTransition(value: unknown): value is TicketTransition {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<TicketTransition>;
  return typeof t.id === "string" && typeof t.name === "string" && typeof t.to?.id === "string" && typeof t.to.name === "string" && typeof t.requiresFields === "boolean";
}

export function ticketHandlers(d: { reader: ResourceReader; connectors: Lookup<SourceConnector>; redactor: Redactor }): RecoverableOutboxHandler[] {
  async function context(msg: OutboxDelivery) {
    const { namespace, workItem, workItemUid } = msg.payload;
    if (typeof namespace !== "string" || typeof workItem !== "string" || typeof workItemUid !== "string") throw new Error("invalid ticket delivery identity");
    if (namespace !== msg.namespace) throw new Error("ticket delivery cannot cross namespaces");
    const ctx = await ticketItem(d.reader, namespace, workItem);
    if (!msg.source || ctx.item.metadata.uid !== workItemUid || ctx.source.metadata.uid !== msg.source.metadata.uid || ctx.externalId !== msg.externalId) throw new Error("ticket destination changed");
    if (typeof msg.payload.sourceVersion !== "string" || msg.payload.sourceVersion !== ctx.source.metadata.resourceVersion) throw new Error("ticket source configuration changed since review");
    return { ...ctx, namespace };
  }
  async function publication(msg: OutboxDelivery) {
    const ctx = await context(msg);
    if (typeof msg.payload.approval !== "string") throw new Error("publication approval is required");
    const approval = await d.reader.get<Approval>("Approval", ctx.namespace, msg.payload.approval);
    if (!approval || approval.metadata.uid !== msg.payload.approvalUid || approval.spec.decision !== "approve") throw new Error("publication approval is unavailable");
    const proposal = await validatePublication(d.reader, d.redactor, ctx.item, approval);
    if (!proposal.reviewed || !approval.spec.decidedBy || approval.spec.decidedBy !== proposal.reviewed.by || fingerprint(proposal) !== msg.payload.reviewHash) throw new Error("reviewed publication changed");
    if (!ctx.source.spec.writeBack?.replyVisibilities?.includes(proposal.reviewed.visibility)) throw new Error("reply visibility is no longer permitted");
    return { ...ctx, approval, proposal, reviewed: proposal.reviewed };
  }
  async function recoverReply(msg: OutboxDelivery) {
    const ctx = await publication(msg), c = d.connectors.get(ctx.source.spec.type);
    if (!hasReplyWriter(c)) throw new Error("source does not support service-desk replies");
    const receipt = await c.findReply(ctx.source, ctx.externalId, marker(ctx.approval), ctx.reviewed.visibility);
    if (!receipt) throw new Error("No matching Jira reply receipt found after interrupted delivery; outcome is unknown");
    return { commentId: receipt.id, visibility: ctx.reviewed.visibility };
  }
  async function transitionContext(msg: OutboxDelivery) {
    const ctx = await context(msg);
    let transition: TicketTransition, fromStatusId: string;
    if (typeof msg.payload.approval === "string") {
      const publicationCtx = await publication(msg);
      const reply = await d.reader.get<OutboxMessage>("OutboxMessage", ctx.namespace, replyKey(publicationCtx.approval));
      if (reply?.status?.phase !== "Delivered" || !publicationCtx.reviewed.transition) throw new Error("the approved reply must be delivered before changing status");
      transition = publicationCtx.reviewed.transition;
      fromStatusId = publicationCtx.reviewed.fromStatusId;
    } else {
      if (typeof msg.payload.requestedBy !== "string" || !msg.payload.requestedBy || typeof msg.payload.requestFingerprint !== "string" || !isTransition(msg.payload.transition) || typeof msg.payload.fromStatusId !== "string") throw new Error("human-confirmed ticket transition is required");
      transition = msg.payload.transition; fromStatusId = msg.payload.fromStatusId;
    }
    if (ctx.source.spec.writeBack?.transitions !== true) throw new Error("source does not permit ticket transitions");
    const c = d.connectors.get(ctx.source.spec.type);
    if (!hasTransitionWriter(c)) throw new Error("source cannot change ticket state");
    return { ...ctx, c, transition, fromStatusId };
  }
  return [{
    action: "service-desk-reply",
    recover: recoverReply,
    async deliver(msg) {
      const ctx = await publication(msg), c = d.connectors.get(ctx.source.spec.type);
      if (!hasReplyWriter(c)) throw new Error("source does not support service-desk replies");
      const existing = await c.findReply(ctx.source, ctx.externalId, marker(ctx.approval), ctx.reviewed.visibility);
      const receipt = existing ?? await c.publishReply(ctx.source, ctx.externalId, `${ctx.proposal.body}\n\n${marker(ctx.approval)}`, ctx.reviewed.visibility);
      return { commentId: receipt.id, visibility: ctx.reviewed.visibility };
    },
  }, {
    action: "ticket-transition",
    async recover(msg) {
      const ctx = await transitionContext(msg), state = await ctx.c.ticketState(ctx.source, ctx.externalId);
      if (state.id !== ctx.transition.to.id) throw new Error("Interrupted Jira transition could not be confirmed; outcome is unknown");
      return { statusId: state.id, status: state.name };
    },
    async deliver(msg) {
      const ctx = await transitionContext(msg), state = await ctx.c.ticketState(ctx.source, ctx.externalId);
      if (state.id === ctx.transition.to.id) return { statusId: state.id, status: state.name };
      if (state.id !== ctx.fromStatusId) throw new Error("Jira status changed since review; choose a fresh transition");
      const available = state.transitions.find((t) => t.id === ctx.transition.id && t.to.id === ctx.transition.to.id);
      if (!available || available.requiresFields) throw new Error("reviewed Jira transition is no longer available or needs a Jira form");
      await ctx.c.transitionTicket(ctx.source, ctx.externalId, available.id);
      const after = await ctx.c.ticketState(ctx.source, ctx.externalId);
      if (after.id !== available.to.id) throw new Error("Jira did not confirm the requested target status");
      return { statusId: after.id, status: after.name };
    },
  }];
}
