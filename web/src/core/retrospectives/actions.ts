import type { RetrospectiveFeedback, WorkItem } from "../model/kinds.ts";
import { StoreError, type Clock, type EventRecorder, type Principal, type Redactor, type ResourceReader, type ResourceWriter,
  type RetrospectiveAggregation, type RetrospectiveCommands, type RetrospectiveQueries } from "../ports/index.ts";

export class RetrospectiveActions implements RetrospectiveQueries, RetrospectiveCommands {
  private readonly d: { namespace: string; reader: ResourceReader; writer: ResourceWriter;
    aggregation: RetrospectiveAggregation; clock: Clock; redactor: Redactor; events: EventRecorder };
  constructor(d: RetrospectiveActions["d"]) { this.d = d; }
  list(_p: Principal) { return this.d.aggregation.groups(this.d.namespace); }

  async investigate(p: Principal, id: string, input: { revision: string; requestId: string }) {
    if (!input || typeof input.requestId !== "string" || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(input.requestId) || input.requestId === "auto") {
      throw new StoreError("A unique requestId (1-50 kebab-case characters, not auto) is required", "Invalid");
    }
    const group = (await this.list(p)).find((g) => g.id === id);
    if (!group) throw new StoreError("Feedback group not found", "NotFound");
    const prior = group.reports.find((r) => r.feedback.spec.investigationRequest?.id === input.requestId);
    if (prior) {
      const request = prior.feedback.spec.investigationRequest!;
      if (request.by !== p.id || request.revision !== input.revision) throw new StoreError("Request ID already used with different input", "Conflict");
      return;
    }
    if (group.revision !== input.revision) throw new StoreError("Feedback changed; refresh before starting an investigation", "Conflict");
    if (group.investigations.some((i) => !["Done", "Closed", "Failed"].includes(i.status?.phase ?? "") &&
      (!i.spec.retrospectiveOutcome || i.spec.retrospectiveOutcome.disposition === "open"))) {
      throw new StoreError("An investigation is already active", "Conflict");
    }
    const feedback = group.reports[0].feedback;
    const request = feedback.spec.investigationRequest;
    if (request && !feedback.status?.investigations?.some((i) => i.cycle === request.id)) {
      throw new StoreError("An investigation request is pending", "Conflict");
    }
    const updated = await this.d.writer.update({ ...feedback, spec: { ...feedback.spec,
      investigationRequest: { id: input.requestId, by: p.id, at: this.d.clock.now().toISOString(), revision: input.revision } } });
    await this.d.events.normal(updated, "RetrospectiveRequested", `${p.id} requested cycle ${input.requestId} against evidence ${input.revision}`);
  }

  async disposition(p: Principal, name: string, input: Parameters<RetrospectiveCommands["disposition"]>[2]) {
    if (!input || !["open", "dismissed"].includes(input.disposition) ||
      typeof input.comment !== "string" || !input.comment.trim() || input.comment.length > 1500) throw new StoreError("Disposition and a reason (1-1500 characters) are required", "Invalid");
    const feedback = await this.d.reader.get<RetrospectiveFeedback>("RetrospectiveFeedback", this.d.namespace, name);
    if (!feedback) throw new StoreError("Feedback not found", "NotFound");
    if (feedback.metadata.resourceVersion !== input.version) throw new StoreError("Feedback changed; refresh first", "Conflict");
    if (input.issueCode !== undefined) {
      const policy = (await this.list(p)).find((g) => g.reports.some((r) => r.feedback.metadata.name === name))!.policy;
      if (!policy.issueCodes.includes(input.issueCode)) throw new StoreError("Select an operator-defined issue code", "Invalid");
    }
    const updated = await this.d.writer.update({ ...feedback, spec: { ...feedback.spec, review: { disposition: input.disposition,
      issueCode: input.issueCode ?? feedback.spec.review?.issueCode, comment: this.d.redactor.redact(input.comment.trim()),
      by: p.id, at: this.d.clock.now().toISOString() } } });
    await this.d.events.normal(updated, "FeedbackReviewed", `${p.id}: ${input.disposition}; ${updated.spec.review?.issueCode ?? updated.spec.observation.issueCode}; ${updated.spec.review?.comment}`);
  }

  async recordOutcome(p: Principal, name: string, input: Parameters<RetrospectiveCommands["recordOutcome"]>[2]) {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item?.spec.retrospective) throw new StoreError("Retrospective not found", "NotFound");
    if (!input || item.metadata.resourceVersion !== input.version) throw new StoreError("Retrospective changed; refresh first", "Conflict");
    if (!["open", "deferred", "closed"].includes(input.disposition)) throw new StoreError("Invalid retrospective disposition", "Invalid");
    for (const value of [input.implementation, input.loadedVersion, input.benefit]) {
      if (value !== undefined && (typeof value !== "string" || value.length > 1500)) throw new StoreError("Outcome fields must be text of at most 1500 characters", "Invalid");
    }
    if (input.disposition === "open" && item.spec.retrospectiveOutcome && item.spec.retrospectiveOutcome.disposition !== "open") {
      throw new StoreError("Start an explicit new investigation cycle instead of reopening a closed cycle", "Invalid");
    }
    const clean = (value?: string) => value ? this.d.redactor.redact(value) : undefined;
    const updated = await this.d.writer.update({ ...item, spec: { ...item.spec, retrospectiveOutcome: {
      disposition: input.disposition, by: p.id, at: this.d.clock.now().toISOString(),
      implementation: clean(input.implementation), loadedVersion: clean(input.loadedVersion), benefit: clean(input.benefit),
    } } });
    await this.d.events.normal(updated, "RetrospectiveOutcomeRecorded", JSON.stringify(updated.spec.retrospectiveOutcome));
  }
}
