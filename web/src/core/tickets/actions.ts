import { randomUUID } from "node:crypto";
import type { Approval, OutboxMessage, WorkItem } from "../model/kinds.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import type { Clock, EventRecorder, Lookup, Outbox, Principal, Redactor, ResourceReader, ResourceWriter, SourceConnector, TicketCommands, TicketQueries, TicketReview, WorkItemRecordReader, WorkflowCompiler } from "../ports/index.ts";
import { isStoreError, StoreError } from "../ports/index.ts";
import { fingerprint } from "../app/work-item-followups.ts";
import { deriveGateEvidence } from "../app/gate-evidence.ts";
import { hasTicketState, publicationProposal, ticketItem, validatePublication } from "./review.ts";

interface TicketActionsDeps {
    namespace: string;
    reader: ResourceReader; writer: ResourceWriter; connectors: Lookup<SourceConnector>; outbox: Outbox;
    clock: Clock; redactor: Redactor; compiler: WorkflowCompiler; records: WorkItemRecordReader; events: EventRecorder;
}

export class TicketActions implements TicketQueries, TicketCommands {
  private readonly namespace: string;
  private readonly d: TicketActionsDeps;
  constructor(d: TicketActionsDeps) { this.d = d; this.namespace = d.namespace; }

  async review(p: Principal, name: string): Promise<TicketReview> {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.namespace, name);
    if (!item) throw new StoreError("work item not found", "NotFound");
    const empty: TicketReview = { enabled: false, visibilities: [], canTransition: false, canStartPublication: false, deliveries: [] };
    if (!item.spec.externalRef) return empty;
    const ctx = await ticketItem(this.d.reader, this.namespace, name);
    const policy = ctx.source.spec.writeBack;
    if (!policy?.replyVisibilities?.length && !policy?.transitions) return empty;
    const connector = this.d.connectors.get(ctx.source.spec.type);
    if (!hasTicketState(connector)) throw new Error("source does not support ticket state and transitions");
    const state = await connector.ticketState(ctx.source, ctx.externalId);
    const a = item.status?.phase === "AwaitingApproval" && item.status.blockedBy?.kind === "Approval" ? await this.d.reader.get<Approval>("Approval", this.namespace, item.status.blockedBy.name) : null;
    const approval = a?.spec.ticketPublication ? a : undefined;
    let publicationError: string | undefined;
    if (approval) {
      try { await validatePublication(this.d.reader, this.d.redactor, item, approval); }
      catch (e) { if (!isStoreError(e, "Conflict")) throw e; publicationError = e.message; }
    }
    const wf = item.spec.workflowRef ? await this.d.compiler.compile(item.spec.workflowRef, this.namespace) : undefined;
    const canStartPublication = item.status?.phase === "Done" && !!wf?.stages.some((s) => s.gate?.publication?.reviewStage === item.status?.stage);
    const deliveries = (await this.d.reader.list<OutboxMessage>("OutboxMessage", { namespace: this.namespace, ownedBy: { kind: "WorkItem", name, namespace: this.namespace } }))
      .filter((m) => m.spec.action === "service-desk-reply" || m.spec.action === "ticket-transition");
    return {
      enabled: true, ticket: { key: ctx.externalId, url: item.spec.externalRef.url, state },
      visibilities: policy.replyVisibilities ?? [], canTransition: policy.transitions === true,
      canStartPublication, approval, publicationError, deliveries,
      revision: fingerprint([item.metadata.uid, item.metadata.resourceVersion, approval?.metadata.resourceVersion, ctx.source.metadata.resourceVersion,
        state.id, [...state.transitions].sort((a, b) => a.id.localeCompare(b.id))]),
    };
  }

  async beginPublication(p: Principal, name: string): Promise<void> {
    const { item } = await ticketItem(this.d.reader, this.namespace, name);
    if (item.status?.phase !== "Done" || !item.spec.workflowRef) throw new Error("only a completed response review can start publication here");
    const wf = await this.d.compiler.compile(item.spec.workflowRef, this.namespace);
    const stage = wf.stages.find((s) => s.gate?.publication?.reviewStage === item.status?.stage);
    if (!stage?.gate?.publication) throw new Error("this workflow has no publication step after the completed review");
    await publicationProposal(this.d.reader, this.d.redactor, { ...item, status: { ...item.status, round: (item.status.round ?? 0) + 1 } }, stage.gate.publication.artifactRef.name, stage.gate.publication.reviewStage);
    await this.d.writer.update({ ...item, spec: { ...item.spec, restart: { id: randomUUID(), stage: stage.name, requestedBy: p.id } } });
  }

  async approvePublication(p: Principal, name: string, input: { revision: string; visibility: "public" | "internal"; transitionId?: string }): Promise<Approval> {
    if (typeof input.revision !== "string" || (input.visibility !== "public" && input.visibility !== "internal") || (input.transitionId !== undefined && typeof input.transitionId !== "string")) throw new Error("a reviewed revision, explicit visibility and optional transition ID are required");
    const ctx = await ticketItem(this.d.reader, this.namespace, name);
    const a = ctx.item.status?.blockedBy?.kind === "Approval" ? await this.d.reader.get<Approval>("Approval", this.namespace, ctx.item.status.blockedBy.name) : null;
    if (!a?.spec.ticketPublication) throw new Error("no publication review is pending");
    const previous = a.spec.ticketPublication.reviewed;
    if (a.spec.decision) {
      if (a.spec.decision === "approve" && previous?.by === p.id && previous.revision === input.revision && previous.visibility === input.visibility && previous.transition?.id === input.transitionId) return a;
      throw new StoreError("publication already decided with different input", "Conflict");
    }
    const review = await this.review(p, name);
    if (!review.ticket) throw new Error("ticket publication is not configured");
    if (review.publicationError) throw new StoreError(review.publicationError, "Conflict");
    if (review.revision !== input.revision) throw new StoreError("ticket or review changed; refresh the publication preview", "Conflict");
    if (!review.visibilities.includes(input.visibility)) throw new Error("selected reply visibility is not permitted");
    const transition = input.transitionId ? review.ticket.state.transitions.find((t) => t.id === input.transitionId) : undefined;
    if (input.transitionId && (!review.canTransition || !transition || transition.requiresFields || transition.to.id === review.ticket.state.id)) throw new Error("selected transition is unavailable, already at its target, or requires a Jira form");
    const evidence = deriveGateEvidence(await this.d.records.read(this.namespace, name));
    if (evidence.status === "blocking") throw new Error("blocking work-item evidence must be resolved before publication");
    const proposal = await validatePublication(this.d.reader, this.d.redactor, ctx.item, a);
    const result = await this.d.writer.update<Approval>({ ...a, spec: { ...a.spec, decision: "approve", decidedBy: p.id,
      ticketPublication: { ...proposal, reviewed: { revision: input.revision, visibility: input.visibility, fromStatusId: review.ticket.state.id, transition, by: p.id } },
    } });
    await this.d.events.normal(ctx.item, "PublicationApproved", `${input.visibility} reply approved by ${p.id}${transition ? `; then ${transition.to.name}` : ""}`);
    return result;
  }

  async requestTransition(p: Principal, name: string, input: { requestId: string; revision: string; transitionId: string }): Promise<OutboxMessage> {
    if (typeof input.requestId !== "string" || !/^[a-z0-9-]{1,60}$/.test(input.requestId) || typeof input.revision !== "string" || typeof input.transitionId !== "string" || !input.transitionId) throw new Error("requestId, reviewed revision and transitionId are required");
    const hash = fingerprint([this.namespace, p.id, name, input.requestId, input.revision, input.transitionId]);
    const key = `ticket-state-${fingerprint([name, input.requestId])}`;
    const existing = await this.d.reader.get<OutboxMessage>("OutboxMessage", this.namespace, key);
    if (existing) {
      if (existing.spec.payload.requestFingerprint !== hash) throw new StoreError("requestId already used with different transition input", "Conflict");
      return existing;
    }
    const ctx = await ticketItem(this.d.reader, this.namespace, name), review = await this.review(p, name);
    if (!review.ticket) throw new Error("ticket transitions are not configured");
    if (review.revision !== input.revision) throw new StoreError("ticket state changed; refresh available transitions", "Conflict");
    const transition = review.ticket?.state.transitions.find((t) => t.id === input.transitionId);
    if (!review.canTransition || !transition || transition.requiresFields || transition.to.id === review.ticket.state.id) throw new Error("transition is not available, already at its target, or requires a Jira form");
    await this.d.outbox.enqueue({
      key, namespace: this.namespace, source: ctx.source.metadata.name, externalId: ctx.externalId, action: "ticket-transition", owner: ownerRef(ctx.item),
      payload: { namespace: this.namespace, workItem: name, workItemUid: ctx.item.metadata.uid, sourceVersion: ctx.source.metadata.resourceVersion, transition, fromStatusId: review.ticket.state.id,
        requestedBy: p.id, requestedAt: this.d.clock.now().toISOString(), requestFingerprint: hash },
    });
    const saved = await this.d.reader.get<OutboxMessage>("OutboxMessage", nsOf(ctx.item), key);
    if (!saved || saved.spec.payload.requestFingerprint !== hash) throw new StoreError("requestId already used with different transition input", "Conflict");
    return saved;
  }
}
