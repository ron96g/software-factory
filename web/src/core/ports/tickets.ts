import type { Approval, OutboxMessage, Source, TicketTransition } from "../model/kinds.ts";
import type { Principal } from "./app.ts";
import type { OutboxDelivery, OutboxHandler } from "./integration.ts";
import type { GateContext, GateDecision } from "./workflow.ts";

export interface TicketState {
  id: string;
  name: string;
  transitions: TicketTransition[];
}

export interface TicketStateReader {
  ticketState(source: Source, externalId: string): Promise<TicketState>;
}

export interface TicketTransitionWriter {
  transitionTicket(source: Source, externalId: string, transitionId: string): Promise<void>;
}

export interface ServiceDeskCommentPublisher {
  publishReply(source: Source, externalId: string, body: string, visibility: "public" | "internal"): Promise<{ id: string }>;
}

export interface ServiceDeskCommentFinder {
  findReply(source: Source, externalId: string, marker: string, visibility: "public" | "internal"): Promise<{ id: string } | null>;
}

/** Source permissions are registered by action; missing policies deny writes. */
export interface SourceWritePolicy {
  check(source: Source): string | undefined;
}

/** A persisted Delivering action is recovered by observation, never by blindly repeating a POST. */
export interface RecoverableOutboxHandler extends OutboxHandler {
  recover(msg: OutboxDelivery): Promise<Record<string, unknown>>;
}

export interface ApprovalGateEvaluator {
  evaluateApproval(ctx: GateContext, approval: Approval): Promise<GateDecision>;
}

export interface TicketReview {
  enabled: boolean;
  ticket?: { key: string; url?: string; state: TicketState };
  visibilities: ("public" | "internal")[];
  canTransition: boolean;
  canStartPublication: boolean;
  approval?: Approval;
  publicationError?: string;
  revision?: string;
  deliveries: OutboxMessage[];
}

/** Bound to a runtime namespace by the composition root. */
export interface TicketQueries {
  review(p: Principal, name: string): Promise<TicketReview>;
}

/** Bound to a runtime namespace by the composition root. */
export interface TicketCommands {
  beginPublication(p: Principal, name: string): Promise<void>;
  approvePublication(p: Principal, name: string, input: { revision: string; visibility: "public" | "internal"; transitionId?: string }): Promise<Approval>;
  requestTransition(p: Principal, name: string, input: { requestId: string; revision: string; transitionId: string }): Promise<OutboxMessage>;
}

