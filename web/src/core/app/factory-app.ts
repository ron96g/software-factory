import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  InlineFeedback,
  KnowledgeEntry,
  IssueProposal,
  Repository,
  Source,
  CheckRun,
  WorkItem,
  Workflow,
  Workspace,
  OutboxMessage,
} from "../model/kinds.ts";
import { isPublishable, REVIEW_VERDICTS, type ReviewVerdict } from "../model/kinds.ts";
import { resolveRef } from "../refs/refs.ts";
import { API_VERSION, DEFAULT_NAMESPACE, SYSTEM_NAMESPACE, type Resource } from "../model/resource.ts";
import { ownerRef } from "../model/meta.ts";
import { issueContentHash } from "../issues/admission.ts";
import { verificationPolicyGaps } from "../model/verification-policy.ts";
import type {
  ConversationActions,
  ConversationResponder,
  DefinitionQueries,
  HumanActions,
  ReplayActions,
  RunReplayer,
  SystemHealth,
  SystemQueries,
  BrowsableKind,
  ResourceBrowser,
  ExecutionEnvironmentSelector,
  ModelResolver,
  ControllerHealth,
  EventRecorder,
  FeedbackActions,
  FeedbackPlan,
  NewFeedbackInput,
  ItemConversationActions,
  Lookup,
  CapabilityDetector,
  CapabilityFacts,
  CompiledWorkflow,
  KindLookup,
  KnowledgeActions,
  IssueProposalActions,
  IssueReviewActions,
  KnowledgeDetail,
  NewItemOptions,
  NewItemOptionsQuery,
  NewWorkItemInput,
  Principal,
  ResourceReader,
  ResourceWriter,
  SourceActions,
  SourceSyncer,
  TranscriptMessage,
  TranscriptQueries,
  TranscriptReader,
  WorkflowCompiler,
  WorkItemCommands,
  WorkItemDetail,
  WorkItemQueries,
  AgentChatQueries,
  AgentChatCommands,
  ChatWorkItemCreator,
  Redactor,
  Clock,
  WorkItemRecordReader,
  WorkItemFollowUpQueries,
  WorkItemFollowUpCommands,
  StartImplementationInput,
  NewFollowUpInput,
  NewFollowUpTicketInput,
  FollowUpRelations,
  FollowUpTicketDrafting,
  FollowUpTicketDrafter,
  FollowUpTicketDraft,
  DraftFollowUpTicketInput,
  DraftFeedbackBatch,
  RestartOptions,
  VerificationApprovalGuard,
  ApprovalDecisionGuard,
  BaseConflictDetector,
  PublishedPullRequest,
  PullRequestMaintenance,
} from "../ports/index.ts";
import { isStoreError, StoreError } from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";
import type { ReviewCoverage, ReviewCoverageReader } from "../ports/index.ts";
import { deriveGateEvidence } from "./gate-evidence.ts";
import { renderFollowUpTicketBody, templateFollowUpTicketBody } from "../issues/followup-body.ts";
import { originOf } from "../issues/origin.ts";
import { workItemNameFor } from "../sources/syncer.ts";
import { externalRefLabel } from "../issues/mirror.ts";
import { fingerprint, followUpPreview, FOLLOW_UP_INPUT, LABEL_ORIGIN_UID } from "./work-item-followups.ts";
import { feedbackViews, planFeedbackSubmission } from "./feedback.ts";

export interface FactoryAppDeps {
  /** ADR-0095 §7: review coverage shown as gate evidence. */
  coverage?: ReviewCoverageReader;
  approvalGuards?: ApprovalDecisionGuard[];
  verificationGuard?: VerificationApprovalGuard;
  reader: ResourceReader;
  writer: ResourceWriter;
  kinds: KindLookup;
  compiler: WorkflowCompiler;
  syncer: SourceSyncer;
  transcripts: TranscriptReader;
  /** Responders by `Conversation.spec.purpose` (registry, X4). */
  responders: Lookup<ConversationResponder>;
  replayer: RunReplayer;
  environments: ExecutionEnvironmentSelector;
  models: ModelResolver;
  controllerHealth: ControllerHealth;
  /** ADR-0062 §3: live check workers (renewed heartbeats) and how many checks they run. */
  checkWorkers?: () => Promise<{ workers: number; running: number }>;
  /** ADR-0062 §3: this process's role, so the UI can tell "no worker exists" from "no check is running". */
  role?: "all" | "web" | "worker";
  /** ADR-0088: profile-declared tools missing from the toolchain cache, per repository. */
  toolGaps?: () => Promise<{ repository: string; tool: string; type: string }[]>;
  /** Audit trail for human overrides (ADR-0027) — required, an override must never go unlogged. */
  events: EventRecorder;
  /** ADR-0029 policy, reported in system health. */
  simulation: "allow" | "wait";
  redactor: Redactor;
  records: WorkItemRecordReader;
  clock: Clock;
  /** ADR-0054: compares published pull requests with the current base. */
  baseConflicts?: BaseConflictDetector;
  /** ADR-0075: item capability detectors by name. Without them an item reports no capabilities. */
  capabilities?: Lookup<CapabilityDetector>;
  /** ADR-0073/0078: submits draft inline notes together with a restart. */
  notes?: DraftFeedbackBatch;
  /** ADR-0076: drafts follow-up tickets; without it, drafting is unavailable and Create uses the template. */
  ticketDrafter?: FollowUpTicketDrafter;
}

const MAX_CONTEXT = 20_000;
const MAX_QUOTE = 4_000;
const MAX_COMMENT = 4_000;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "item";

/**
 * Use cases behind the API. Every method takes a Principal (ADR-0009); authorization
 * and namespace scoping plug in here in v0.4. MVP: single namespace `default`.
 */
export class FactoryApp
  implements
    WorkItemQueries,
    WorkItemCommands,
    HumanActions,
    SourceActions,
    TranscriptQueries,
    ConversationActions,
    DefinitionQueries,
    ReplayActions,
    SystemQueries,
    ResourceBrowser,
    ItemConversationActions,
    NewItemOptionsQuery,
    KnowledgeActions,
    IssueProposalActions,
    IssueReviewActions,
    AgentChatQueries,
    AgentChatCommands,
    ChatWorkItemCreator,
    WorkItemFollowUpQueries,
    WorkItemFollowUpCommands,
    FollowUpTicketDrafting,
    PullRequestMaintenance,
    FeedbackActions
{
  private readonly d: FactoryAppDeps;
  private readonly ns = DEFAULT_NAMESPACE;
  constructor(d: FactoryAppDeps) {
    this.d = d;
  }

  async listWorkItems(_p: Principal): Promise<WorkItem[]> {
    return (await this.d.reader.list<WorkItem>("WorkItem", { namespace: this.ns })).sort((a, b) =>
      (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
    );
  }

  async getWorkItem(_p: Principal, name: string): Promise<WorkItemDetail | null> {
    const workItem = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!workItem) return null;
    const owned = { kind: "WorkItem", name, namespace: this.ns };
    const [runs, artifacts, clarifications, approvals, conversations, workspaces, outbox, events, feedback] = await Promise.all([
      this.d.reader.list<AgentRun>("AgentRun", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Artifact>("Artifact", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Clarification>("Clarification", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Approval>("Approval", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Conversation>("Conversation", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Workspace>("Workspace", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<OutboxMessage>("OutboxMessage", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<FactoryEvent>("Event", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: name } }),
      this.d.reader.list<InlineFeedback>("InlineFeedback", { namespace: this.ns, ownedBy: owned }),
    ]);
    let stages: WorkItemDetail["stages"] = [];
    let verified = false;
    let feedbackPlan: FeedbackPlan | undefined;
    let workflow: CompiledWorkflow | undefined;
    if (workItem.spec.workflowRef) {
      try {
        const wf = workflow = await this.d.compiler.compile(workItem.spec.workflowRef, this.ns);
        verified = !!wf.verification;
        stages = wf.stages.map((s) => ({ name: s.name, lifecyclePhase: s.lifecyclePhase, gate: s.gate?.type,
          steps: s.steps.map((step) => ({ name: step.name, agent: step.agentRef.name })), ...(s.publish?.pullRequest ? { publishes: true } : {}) }));
        const drafts = feedback.filter((f) => !f.spec.submitted);
        const open = approvals.find((a) => a.metadata.name === workItem.status?.blockedBy?.name);
        if (drafts.length) feedbackPlan = planFeedbackSubmission(drafts, workItem, wf, open);
      } catch {
        // a broken workflow is surfaced through the item's status
      }
    }
    const coverage = new Map<string, ReviewCoverage>();
    if (this.d.coverage) {
      for (const r of runs.filter((r) => !r.spec.replayOf && r.status?.phase === "Succeeded")) {
        const c = await this.d.coverage.coverage(r);
        if (c) coverage.set(r.metadata.name, c);
      }
    }
    const evidence = deriveGateEvidence({ runs, events, clarifications, artifacts, verified, coverage });
    const knowledge = await this.d.reader.list<KnowledgeEntry>("KnowledgeEntry", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: name } });
    const repositories = await Promise.all([...new Set(workspaces.map((w) => w.spec.repositoryRef.name))].map(async (repo) => {
      const resolved = await resolveRef<Repository>(this.d.reader, "Repository", { name: repo }, this.ns);
      return { name: repo, publishable: !!resolved && isPublishable(resolved) };
    }));
    const issues = await this.d.reader.list<IssueProposal>("IssueProposal", { namespace: this.ns, ownedBy: { kind: "WorkItem", name, namespace: this.ns } });
    const capabilities = await this.capabilities({ workItem, workflow, runs, outbox });
    return {
      workItem, runs, artifacts, clarifications, approvals, conversations, workspaces, outbox, evidence, events, stages, repositories, knowledge, issues,
      feedback: feedbackViews(feedback, runs, artifacts).sort((a, b) => (a.feedback.metadata.creationTimestamp ?? "").localeCompare(b.feedback.metadata.creationTimestamp ?? "")),
      feedbackPlan, capabilities,
    };
  }

  private async capabilities(facts: Omit<CapabilityFacts, "source" | "checkRuns">): Promise<string[]> {
    const detectors = this.d.capabilities;
    if (!detectors?.keys().length) return [];
    const { workItem } = facts;
    const [source, checkRuns] = await Promise.all([
      resolveRef<Source>(this.d.reader, "Source", workItem.spec.sourceRef, this.ns),
      this.d.reader.list<CheckRun>("CheckRun", { namespace: this.ns, ownedBy: { kind: "WorkItem", name: workItem.metadata.name, namespace: this.ns } }),
    ]);
    const all = { ...facts, source: source ?? undefined, checkRuns };
    return detectors.keys().filter((name) => detectors.get(name)!.detect(all)).sort();
  }

  async newItemOptions(_p: Principal): Promise<NewItemOptions> {
    const [workflows, repositories, manual] = await Promise.all([
      this.d.reader.list<Workflow>("Workflow"),
      this.d.reader.list<Repository>("Repository"),
      resolveRef<Source>(this.d.reader, "Source", { name: "manual" }, this.ns),
    ]);
    const subWorkflows = new Set(
      workflows.flatMap((w) => w.spec.phases.flatMap((ph) => ph.stages.map((st) => st.workflowRef?.name).filter((n): n is string => !!n))),
    );
    const describe = (r: Resource) => ({ name: r.metadata.name, description: r.metadata.annotations?.description?.trim() });
    const ticketBlock = (w: Workflow) => w.spec.phases.flatMap((ph) => ph.stages).find((st) => st.publish?.issue)?.publish?.issue;
    return {
      workflows: workflows.filter((w) => !subWorkflows.has(w.metadata.name) && w.metadata.labels?.["factory.ai-dlc.io/internal"] !== "true").map((w) => {
        const block = ticketBlock(w);
        return { ...describe(w), ...(block ? { publishesTicket: { target: block.targetRef?.name } } : {}) };
      }),
      repositories: repositories.filter((r) => !!r.spec.local?.path).map(describe),
      defaults: {
        workflow: manual?.spec.defaults?.workflowRef?.name,
        repositories: (manual?.spec.defaults?.repositoryRefs ?? []).map((r) => r.name),
      },
      issueTargets: (await this.listIssueTargets(_p)).map((t) => ({ source: t.source, type: t.type, project: t.project, issueType: t.issueType, labels: t.labels })),
    };
  }

  async createWorkItem(p: Principal, input: NewWorkItemInput): Promise<WorkItem> {
    return this.createItem(p, input);
  }

  private async newItem(p: Principal, input: NewWorkItemInput): Promise<WorkItem> {
    if (!input.title?.trim()) throw new Error("title is required");
    if ((input.context?.length ?? 0) > MAX_CONTEXT) throw new Error(`context is too long (max ${MAX_CONTEXT} characters)`);
    if (input.workflowRef || input.repositoryRefs?.length) {
      const options = await this.newItemOptions(p);
      if (input.workflowRef && !options.workflows.some((w) => w.name === input.workflowRef)) {
        throw new Error(`workflow "${input.workflowRef}" can't be used for a new item`);
      }
      const unusable = (input.repositoryRefs ?? []).filter((r) => !options.repositories.some((o) => o.name === r));
      if (unusable.length) throw new Error(`repositories without a local checkout can't be used yet: ${unusable.join(", ")}`);
    }
    // ADR-0084: a workflow that publishes a ticket gets its target here; a mirror would file a second, raw ticket.
    const publishes = input.workflowRef ? (await this.newItemOptions(p)).workflows.find((w) => w.name === input.workflowRef)?.publishesTicket : undefined;
    if (input.ticketTarget !== undefined) {
      if (!publishes) throw new Error("a ticket target needs a workflow that publishes a ticket");
      if (!(await this.listIssueTargets(p)).some((t) => t.source === input.ticketTarget)) throw new Error(`source "${input.ticketTarget}" does not permit creating issues`);
    }
    if (publishes && input.mirrorTo) throw new Error("this workflow publishes the ticket itself; choose its tracker instead of \"Also create in\"");
    return {
      apiVersion: API_VERSION,
      kind: "WorkItem",
      metadata: { name: slug(input.title), namespace: this.ns, annotations: { "factory.ai-dlc.io/created-by": p.id } },
      spec: {
        title: input.title.trim(),
        description: input.description?.trim(),
        context: input.context?.trim() || undefined,
        sourceRef: { name: "manual" },
        workflowRef: input.workflowRef ? { name: input.workflowRef } : undefined,
        repositoryRefs: input.repositoryRefs?.length ? input.repositoryRefs.map((name) => ({ name })) : undefined,
        ...(input.ticketTarget ? { ticketTarget: { name: input.ticketTarget } } : {}),
      },
    };
  }

  private async createItem(p: Principal, input: NewWorkItemInput, origin?: Conversation): Promise<WorkItem> {
    const item = await this.newItem(p, input);
    const base = origin ? `from-${origin.metadata.name}` : item.metadata.name;
    let name = base;
    if (!origin) for (let i = 2; await this.d.reader.get("WorkItem", this.ns, name); i++) name = `${base}-${i}`;
    item.metadata.name = name;
    item.spec.conversationRef = origin ? { name: origin.metadata.name } : undefined;
    try {
      const created = await this.d.writer.create<WorkItem>(item);
      if (input.mirrorTo) await this.proposeMirror(p, created, input.mirrorTo);
      return created;
    } catch (e) {
      if (!origin || !isStoreError(e, "AlreadyExists")) throw e;
      const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
      if (existing?.spec.conversationRef?.name !== origin.metadata.name) throw e;
      return existing;
    }
  }

  /** ADR-0066 §6: the proposal stays Proposed; a human approves it on the item page. */
  private async proposeMirror(p: Principal, item: WorkItem, target: string): Promise<void> {
    const targets = await this.listIssueTargets(p);
    if (!targets.some((t) => t.source === target)) throw new Error(`source "${target}" does not permit creating issues`);
    const r = this.d.redactor;
    await this.d.writer.create<IssueProposal>({
      apiVersion: API_VERSION,
      kind: "IssueProposal",
      metadata: { name: `${item.metadata.name}-mirror`, namespace: this.ns, ownerReferences: [ownerRef(item)] },
      spec: {
        purpose: "mirror",
        targetRef: { name: target },
        title: r.redact(item.spec.title).slice(0, 200),
        body: r.redact(item.spec.description?.trim() || item.spec.title),
        pickUp: false,
        provenance: { proposedBy: p.id, human: true, workItem: item.metadata.name, proposedAt: new Date().toISOString() },
      },
    });
  }

  async listIssueProposals(_p: Principal): Promise<IssueProposal[]> {
    return this.d.reader.list<IssueProposal>("IssueProposal", { namespace: this.ns });
  }

  private async issueOrThrow(name: string): Promise<IssueProposal> {
    const e = await this.d.reader.get<IssueProposal>("IssueProposal", this.ns, name);
    if (!e) throw new Error(`issue proposal ${name} not found`);
    return e;
  }

  async updateIssueProposal(p: Principal, name: string, patch: { title?: string; body?: string; issueType?: string; labels?: string[]; pickUp?: boolean; targetSource?: string }): Promise<IssueProposal> {
    const e = await this.issueOrThrow(name);
    const r = this.d.redactor;
    const title = patch.title !== undefined ? r.redact(patch.title.trim()).slice(0, 200) : e.spec.title;
    const body = patch.body !== undefined ? r.redact(patch.body.trim()) : e.spec.body;
    if (!title || !body) throw new Error("title and body are required");
    if (patch.targetSource && !(await this.listIssueTargets(p)).some((t) => t.source === patch.targetSource)) throw new Error(`source "${patch.targetSource}" does not permit creating issues`);
    const labels = patch.labels !== undefined ? patch.labels.map((l) => r.redact(l.trim())).filter(Boolean).slice(0, 10) : e.spec.labels;
    // Any edit drops the earlier decision: approval is bound to the content that was reviewed.
    return this.d.writer.update<IssueProposal>({
      ...e,
      spec: {
        ...e.spec, title, body, labels,
        issueType: patch.issueType !== undefined ? r.redact(patch.issueType.trim()) || undefined : e.spec.issueType,
        pickUp: patch.pickUp ?? e.spec.pickUp,
        targetRef: patch.targetSource ? { name: patch.targetSource } : e.spec.targetRef,
        review: undefined,
      },
    });
  }

  async reviewIssueProposal(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<IssueProposal> {
    if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
    const e = await this.issueOrThrow(name);
    return this.d.writer.update<IssueProposal>({
      ...e,
      spec: { ...e.spec, review: { decision, ...(decision === "approve" ? { contentHash: issueContentHash(e.spec) } : {}), by: p.id, at: new Date().toISOString(), comment: comment?.trim() || undefined } },
    });
  }

  async resolveIssueProposal(p: Principal, name: string, input: { action: "create-again" | "link"; externalId?: string }): Promise<IssueProposal> {
    if (input.action !== "create-again" && input.action !== "link") throw new Error("action must be create-again or link");
    if (input.action === "link" && !input.externalId?.trim()) throw new Error("externalId is required to link an existing issue");
    const e = await this.issueOrThrow(name);
    if (e.status?.phase !== "Uncertain" && e.status?.phase !== "Failed") throw new Error("only an uncertain or failed proposal can be resolved");
    return this.d.writer.update<IssueProposal>({
      ...e,
      spec: { ...e.spec, resolution: { action: input.action, externalId: input.externalId?.trim() || undefined, by: p.id, at: new Date().toISOString() } },
    });
  }

  async previewWorkItemFollowUp(_p: Principal, name: string, context = "") {
    if (typeof context !== "string") throw new Error("context must be text");
    return followUpPreview(await this.d.records.read(this.ns, name), context, this.d.redactor, this.d.clock.now().toISOString(), MAX_CONTEXT);
  }

  async workItemFollowUps(_p: Principal, name: string): Promise<FollowUpRelations> {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!item) throw new StoreError(`work item ${name} not found`, "NotFound");
    if (!item.metadata.uid) throw new Error("work item has no persisted identity");
    const items = (await this.d.reader.list<WorkItem>("WorkItem", { namespace: this.ns, labelSelector: { [LABEL_ORIGIN_UID]: item.metadata.uid } }))
      .filter((w) => w.spec.originWorkItemRef?.name === name && w.spec.originSnapshot?.uid === item.metadata.uid);
    const ref = item.spec.originWorkItemRef;
    if (!ref) return { items };
    const origin = !ref.namespace || ref.namespace === this.ns ? await this.d.reader.get<WorkItem>("WorkItem", this.ns, ref.name) : null;
    const available = !!origin && origin.metadata.uid === item.spec.originSnapshot?.uid;
    return { items, origin: { name: ref.name, title: available ? origin.spec.title : undefined, available } };
  }

  async createWorkItemFollowUp(p: Principal, name: string, input: NewFollowUpInput): Promise<WorkItem> {
    if (typeof input.requestId !== "string" || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(input.requestId)) throw new Error("requestId must be a name of at most 50 characters");
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) throw new Error("a reviewed context preview is required");
    if (typeof input.workflowRef !== "string" || !input.workflowRef.trim()) throw new Error("select a workflow");
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("title is required");
    if (input.description !== undefined && typeof input.description !== "string") throw new Error("description must be text");
    if (input.context !== undefined && typeof input.context !== "string") throw new Error("context must be text");
    if (!Array.isArray(input.repositoryRefs) || !input.repositoryRefs.length || input.repositoryRefs.some((r) => typeof r !== "string")) throw new Error("select at least one repository by name");
    const cleaned = { ...input, title: this.d.redactor.redact(input.title), description: input.description === undefined ? undefined : this.d.redactor.redact(input.description), context: this.d.redactor.redact(input.context ?? "") };
    const hash = fingerprint([this.ns, name, cleaned.requestId, cleaned.expectedRevision, cleaned.title, cleaned.description, cleaned.context, cleaned.workflowRef, cleaned.repositoryRefs,
      ...(input.authorizePublication === undefined ? [] : [input.authorizePublication])]);
    const target = `followup-${input.requestId}`;
    const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, target);
    if (existing) {
      if (existing.metadata.annotations?.[FOLLOW_UP_INPUT] !== hash) throw new StoreError("requestId was already used with different follow-up input", "Conflict");
      return existing;
    }
    const preview = await this.previewWorkItemFollowUp(p, name, cleaned.context);
    if (preview.revision !== input.expectedRevision) throw new StoreError("Origin evidence or instructions changed. Refresh the context preview before creating the follow-up.", "Conflict");
    const origin = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!origin || origin.metadata.uid !== preview.snapshot.uid || origin.metadata.resourceVersion !== preview.snapshot.resourceVersion) {
      throw new StoreError("Origin changed during creation; refresh the context preview", "Conflict");
    }
    if (origin?.spec.retrospective) {
      const workflow = await this.d.compiler.compile({ name: input.workflowRef }, this.ns);
      if (workflow.stages.some((s) => s.publish) && input.authorizePublication !== true) {
        throw new StoreError("This workflow publishes before its ship approval. Explicit publication authorization is required; retrospective approval does not authorize it.", "Invalid");
      }
    }
    const item = await this.newItem(p, cleaned);
    item.metadata.name = target;
    item.metadata.labels = { [LABEL_ORIGIN_UID]: preview.snapshot.uid };
    item.metadata.annotations = { ...item.metadata.annotations, [FOLLOW_UP_INPUT]: hash };
    item.spec.context = preview.instructions || undefined;
    item.spec.originWorkItemRef = { name };
    item.spec.originSnapshot = preview.snapshot;
    if (origin?.spec.retrospective && input.authorizePublication === true) {
      item.metadata.annotations = { ...item.metadata.annotations, "factory.ai-dlc.io/publication-authorized-by": p.id };
    }
    try {
      return await this.d.writer.create(item);
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
      const duplicate = await this.d.reader.get<WorkItem>("WorkItem", this.ns, target);
      if (duplicate?.metadata.annotations?.[FOLLOW_UP_INPUT] !== hash) throw new StoreError("requestId was already used with different follow-up input", "Conflict");
      return duplicate;
    }
  }

  async createFollowUpTicket(p: Principal, name: string, input: NewFollowUpTicketInput): Promise<IssueProposal> {
    if (typeof input.requestId !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.requestId)) throw new Error("requestId must be a name of at most 40 characters");
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) throw new Error("a reviewed context preview is required");
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("title is required");
    if (typeof input.targetSource !== "string" || !input.targetSource) throw new Error("select a destination source");
    if (input.body !== undefined && (typeof input.body !== "string" || !input.body.trim())) throw new Error("body must be non-empty text");
    if ((input.body?.length ?? 0) > MAX_CONTEXT) throw new Error(`body is too long (max ${MAX_CONTEXT} characters)`);
    if (input.draftConversation !== undefined && typeof input.draftConversation !== "string") throw new Error("draftConversation must be a name");
    const targets = await this.listIssueTargets(p);
    if (!targets.some((t) => t.source === input.targetSource)) throw new Error(`source "${input.targetSource}" does not permit creating issues`);
    const target = await this.d.reader.get<Source>("Source", SYSTEM_NAMESPACE, input.targetSource);
    const origin = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!origin) throw new StoreError(`work item ${name} not found`, "NotFound");
    const r = this.d.redactor;
    const title = r.redact(input.title.trim()).slice(0, 200);
    const reviewed = input.body ?? templateFollowUpTicketBody({ instructions: r.redact(input.instructions ?? ""), originTitle: origin.spec.title, originDescription: origin.spec.description });
    const body = r.redact(renderFollowUpTicketBody({ body: reviewed, originUrl: origin.spec.externalRef?.url, originName: name, factoryUrl: process.env.FACTORY_PUBLIC_URL }));
    const proposalName = `${name}-followup-${input.requestId}`;
    const existing = await this.d.reader.get<IssueProposal>("IssueProposal", this.ns, proposalName);
    if (existing) {
      if (existing.spec.revision !== input.expectedRevision || existing.spec.targetRef?.name !== input.targetSource || existing.spec.title !== title || existing.spec.body !== body) {
        throw new StoreError("requestId was already used with different follow-up input", "Conflict");
      }
      return existing;
    }
    const preview = await this.previewWorkItemFollowUp(p, name, input.instructions ?? "");
    if (preview.revision !== input.expectedRevision) throw new StoreError("Origin evidence or instructions changed. Refresh the context preview before creating the ticket.", "Conflict");
    const conversation = input.draftConversation ? await this.draftConversationOf(name, input.draftConversation) : undefined;
    const answered = conversation?.status?.transcriptRef && conversation.spec.agentRef
      && (await this.d.transcripts.read(conversation.status.transcriptRef)).some((m) => m.role === "assistant" && m.author.id === conversation.spec.agentRef?.name);
    const draftedBy = answered ? { agent: conversation.spec.agentRef!.name, conversation: conversation.metadata.name } : undefined;
    const cfg = target?.spec.writeBack?.issues;
    const spec: IssueProposal["spec"] = {
      purpose: "follow-up",
      targetRef: { name: input.targetSource },
      title,
      body,
      issueType: input.issueType?.trim() ? r.redact(input.issueType.trim()) : cfg?.issueType,
      ...(input.labels?.length ? { labels: input.labels.map((l) => r.redact(l.trim())).filter(Boolean).slice(0, 10) } : {}),
      pickUp: false,
      revision: preview.revision,
      provenance: { proposedBy: p.id, human: true, workItem: name, proposedAt: new Date().toISOString(),
        ...(draftedBy ? { draftedBy } : {}) },
    };
    const at = new Date().toISOString();
    try {
      return await this.d.writer.create<IssueProposal>({
        apiVersion: API_VERSION, kind: "IssueProposal",
        metadata: { name: proposalName, namespace: this.ns, ownerReferences: [ownerRef(origin)] },
        spec: { ...spec, review: { decision: "approve", by: p.id, at, contentHash: issueContentHash(spec) } },
      });
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
      return (await this.d.reader.get<IssueProposal>("IssueProposal", this.ns, proposalName))!;
    }
  }

  private async draftConversationOf(workItem: string, name: string): Promise<Conversation> {
    const c = await this.d.reader.get<Conversation>("Conversation", this.ns, name);
    if (!c || c.spec.purpose !== "draft-ticket" || c.spec.workItemRef?.name !== workItem) throw new Error(`draft conversation ${name} does not belong to work item ${workItem}`);
    return c;
  }

  async draftFollowUpTicket(p: Principal, name: string, input: DraftFollowUpTicketInput): Promise<FollowUpTicketDraft> {
    const drafter = this.d.ticketDrafter;
    if (!drafter) throw new Error("ticket drafting is not configured");
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) throw new Error("a reviewed context preview is required");
    if (typeof input.targetSource !== "string" || !input.targetSource) throw new Error("select a destination source");
    for (const [field, value] of [["title", input.title], ["instructions", input.instructions], ["feedback", input.feedback], ["conversation", input.conversation]] as const) {
      if (value !== undefined && typeof value !== "string") throw new Error(`${field} must be text`);
    }
    if (input.previous !== undefined && (typeof input.previous !== "object" || typeof input.previous?.title !== "string" || typeof input.previous.body !== "string")) throw new Error("previous must have a title and a body");
    if ((input.feedback?.length ?? 0) + (input.previous?.body.length ?? 0) > MAX_CONTEXT) throw new Error(`draft and feedback are too long (max ${MAX_CONTEXT} characters)`);
    const target = (await this.listIssueTargets(p)).find((t) => t.source === input.targetSource);
    if (!target) throw new Error(`source "${input.targetSource}" does not permit creating issues`);
    const preview = await this.previewWorkItemFollowUp(p, name, input.instructions ?? "");
    if (preview.revision !== input.expectedRevision) throw new StoreError("Origin evidence or instructions changed. Refresh the context preview before drafting.", "Conflict");
    const origin = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!origin) throw new StoreError(`work item ${name} not found`, "NotFound");
    const conversation = input.conversation
      ? await this.draftConversationOf(name, input.conversation)
      : await this.awaitTranscript(await this.d.writer.create<Conversation>({
        apiVersion: API_VERSION, kind: "Conversation",
        metadata: { name: "", generateName: `${name.slice(0, 50)}-draft-`, namespace: this.ns, ownerReferences: [ownerRef(origin)] },
        spec: { workItemRef: { name }, agentRef: { name: drafter.agent }, purpose: "draft-ticket", startedBy: p.id,
          title: this.d.redactor.redact(`Ticket draft: ${origin.spec.title}`).slice(0, 200) },
      }));
    const draft = await drafter.draft(conversation, {
      namespace: this.ns, originTitle: origin.spec.title, originDescription: origin.spec.description,
      instructions: preview.instructions, evidence: preview.snapshot.content,
      target: { source: target.source, type: target.type, project: target.project, issueType: target.issueType },
      title: input.title, previous: input.previous, feedback: input.feedback,
    }, { type: "human", id: p.id });
    return { ...draft, conversation: conversation.metadata.name };
  }

  async startImplementation(_p: Principal, proposalName: string, input: StartImplementationInput = {}): Promise<WorkItem> {
    const prop = await this.d.reader.get<IssueProposal>("IssueProposal", this.ns, proposalName);
    if (!prop || (prop.spec.purpose !== "follow-up" && prop.spec.purpose !== "story")) throw new StoreError(`ticket ${proposalName} not found`, "NotFound");
    const ext = prop.status?.externalRef;
    if (prop.status?.phase !== "Created" || !ext || !prop.spec.targetRef) throw new StoreError("the ticket is not created yet", "Conflict");
    const sourceName = prop.spec.targetRef.name;
    const source = await this.d.reader.get<Source>("Source", SYSTEM_NAMESPACE, sourceName);
    const name = workItemNameFor(sourceName, ext.externalId);
    const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (existing) return existing;
    const origin = await originOf({ reader: this.d.reader, records: this.d.records, redactor: this.d.redactor, clock: this.d.clock }, prop);
    if (!origin) throw new StoreError("the origin work item is no longer available", "Conflict");
    const wf = input.workflowRef ? { name: input.workflowRef } : source?.spec.defaults?.workflowRef;
    // The ticket's Source defaults describe items synced from that tracker; the code the ticket was researched against is the origin's.
    const { repositoryRefs: originRepos, ...originRefs } = origin;
    const repos = input.repositories?.length ? input.repositories.map((n) => ({ name: n })) : originRepos ?? source?.spec.defaults?.repositoryRefs;
    if (!repos?.length) throw new StoreError("choose the repositories to implement in", "Conflict");
    try {
      return await this.d.writer.create<WorkItem>({
        apiVersion: API_VERSION, kind: "WorkItem",
        metadata: { name, namespace: this.ns, labels: { "factory.ai-dlc.io/external-ref": externalRefLabel(sourceName, ext.externalId) } },
        spec: {
          title: this.d.redactor.redact(prop.spec.title), description: prop.spec.body,
          sourceRef: { name: sourceName }, externalRef: { id: ext.externalId, url: ext.url },
          ...(wf ? { workflowRef: wf } : {}), ...(repos?.length ? { repositoryRefs: repos } : {}),
          ...originRefs,
        },
      });
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
      return (await this.d.reader.get<WorkItem>("WorkItem", this.ns, name))!;
    }
  }

  async chatAgents(_p: Principal): Promise<Agent[]> {
    return (await this.d.reader.list<Agent>("Agent", { namespace: SYSTEM_NAMESPACE })).filter((a) => !!a.spec.chat?.allowedTools.length);
  }

  async listAgentChats(_p: Principal, workItem?: string): Promise<Conversation[]> {
    if (workItem !== undefined && (typeof workItem !== "string" || !workItem.trim())) throw new Error("workItem must be a non-empty name");
    return (await this.d.reader.list<Conversation>("Conversation", { namespace: this.ns, labelSelector: workItem ? { [LABEL_WORKITEM]: workItem } : undefined }))
      .filter((c) => c.spec.purpose === "agent-chat" && (!workItem || c.spec.workItemRef?.name === workItem))
      .sort((a, b) => (b.status?.lastMessageAt ?? b.metadata.creationTimestamp ?? "").localeCompare(a.status?.lastMessageAt ?? a.metadata.creationTimestamp ?? ""));
  }

  async getAgentChat(p: Principal, name: string) {
    const conversation = await this.d.reader.get<Conversation>("Conversation", this.ns, name);
    if (!conversation || conversation.spec.purpose !== "agent-chat") return null;
    return { conversation, messages: await this.conversationMessages(p, name) };
  }

  async startAgentChat(p: Principal, agentName: string, title?: string, workItem?: string): Promise<Conversation> {
    if (typeof agentName !== "string" || !agentName) throw new Error("agent is required");
    const agent = await resolveRef<Agent>(this.d.reader, "Agent", { name: agentName }, this.ns);
    if (!agent?.spec.chat?.allowedTools.length) throw new Error("this agent is not enabled for direct chat");
    if (title !== undefined && (typeof title !== "string" || title.length > 200)) throw new Error("chat title must be at most 200 characters");
    if (workItem !== undefined && (typeof workItem !== "string" || !workItem.trim())) throw new Error("workItem must be a non-empty name");
    const item = workItem ? await this.d.reader.get<WorkItem>("WorkItem", this.ns, workItem) : undefined;
    if (workItem && !item) throw new Error(`work item ${workItem} not found`);
    return this.d.writer.create<Conversation>({
      apiVersion: API_VERSION, kind: "Conversation",
      metadata: { name: `chat-${randomUUID()}`, namespace: this.ns, labels: item ? { [LABEL_WORKITEM]: item.metadata.name } : undefined },
      spec: { purpose: "agent-chat", agentRef: { name: agent.metadata.name }, workItemRef: item ? { name: item.metadata.name } : undefined,
        title: this.d.redactor.redact(title?.trim() || `Chat with ${agentName}${item ? `: ${item.spec.title}` : ""}`.slice(0, 200)), startedBy: p.id },
    });
  }

  async submitAgentChatTurn(p: Principal, name: string, input: { id: string; text: string }): Promise<Conversation> {
    if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) throw new Error("a valid turn id is required");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_CONTEXT) throw new Error(`message must contain 1-${MAX_CONTEXT} characters`);
    for (let attempt = 0; ; attempt++) {
      const detail = await this.getAgentChat(p, name);
      if (!detail) throw new Error("agent chat not found");
      const c = detail.conversation;
      const text = this.d.redactor.redact(input.text.trim());
      if (c.spec.turn?.id === input.id) {
        if (c.spec.turn.text !== text || c.spec.turn.submittedBy !== p.id) throw new Error("turn id already used for a different request");
        return c;
      }
      const previous = detail.messages.find((m) => m.role === "user" && m.meta?.turnId === input.id);
      if (previous) {
        if (previous.content !== text || previous.author.id !== p.id) throw new Error("turn id already used for a different request");
        return c;
      }
      const pending = c.spec.turn && c.status?.completedTurn !== c.spec.turn.id &&
        !(c.status?.phase === "Failed" && c.status.activeTurn === c.spec.turn.id);
      if (pending) throw new Error("a turn is already pending; wait for its answer before sending another");
      try {
        return await this.d.writer.update({ ...c, spec: {
          ...c.spec, turn: { id: input.id, text, submittedBy: p.id },
          title: c.spec.turn ? c.spec.title : text.slice(0, 100),
        } });
      } catch (e) {
        if (!isStoreError(e, "Conflict") || attempt >= 3) throw e;
      }
    }
  }

  async createChatWorkItem(p: Principal, name: string, input: NewWorkItemInput): Promise<WorkItem> {
    const detail = await this.getAgentChat(p, name);
    if (!detail) throw new Error("agent chat not found");
    if (detail.conversation.spec.workItemRef) throw new Error("this chat already has a work item; open the existing item instead");
    const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, `from-${name}`);
    if (existing?.spec.conversationRef?.name === name) return existing;
    if (detail.conversation.status?.phase !== "Ready" ||
        detail.conversation.spec.turn?.id !== detail.conversation.status.completedTurn) throw new Error("wait for a completed chat answer before creating a work item");
    const excerpt = detail.messages.filter((m) => m.role === "user" || (m.role === "assistant" && m.meta?.final === true))
      .map((m) => `${m.at} ${m.author.id}:\n${m.content}`).join("\n\n");
    const prefix = `${input.context?.trim() ?? ""}\n\nSource conversation: ${name}\nTranscript: ${detail.conversation.status.transcriptRef?.namespace}/${detail.conversation.status.transcriptRef?.id}\n\nConversation findings (bounded excerpt; observations may be stale):\n`;
    if (prefix.length > MAX_CONTEXT) throw new Error("additional context is too long");
    const remaining = MAX_CONTEXT - prefix.length;
    const context = this.d.redactor.redact(prefix + (remaining ? excerpt.slice(-remaining) : ""));
    return this.createItem(p, {
      ...input, title: this.d.redactor.redact(input.title), description: input.description ? this.d.redactor.redact(input.description) : undefined, context,
    }, detail.conversation);
  }

  async restartWorkItem(p: Principal, name: string, stage?: string, options: RestartOptions = {}): Promise<WorkItem> {
    if (options.context !== undefined && typeof options.context !== "string") throw new Error("context must be text");
    await this.assertNoActiveChecks(name);
    const id = randomUUID();
    let notes: string[] = [];
    try {
      for (let attempt = 0; ; attempt++) {
        const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
        if (!wi) throw new Error(`work item ${name} not found`);
        const wf = wi.spec.workflowRef ? await this.d.compiler.compile(wi.spec.workflowRef, this.ns) : undefined;
        if (stage) {
          if (!wf) throw new Error(`work item ${name} has no workflow`);
          if (!wf.stage(stage)) throw new Error(`stage "${stage}" not found in workflow ${wi.spec.workflowRef!.name}`);
        }
        let context = wi.spec.context;
        if (options.context !== undefined) {
          const available = MAX_CONTEXT - (wi.spec.originSnapshot?.content.length ?? 0);
          if (options.context.length > available) throw new Error(`context is too long (max ${available} characters alongside inherited evidence)`);
          context = this.d.redactor.redact(options.context.trim()) || undefined;
        }
        // ADR-0085: mark first, so the re-run already sees the notes as submitted (same batch as the restart, ADR-0073).
        if (options.includeDraftNotes && this.d.notes && wf && attempt === 0) {
          const stages = wf.stages.map((s) => s.name);
          notes = await this.d.notes.include(p, name, stages.slice(Math.max(0, stage ? stages.indexOf(stage) : 0)), id);
        }
        try {
          const updated = await this.d.writer.update<WorkItem>({ ...wi, spec: { ...wi.spec, context, restart: { id, stage, requestedBy: p.id } } });
          if (context !== wi.spec.context) await this.d.events.normal(updated, "ContextUpdated", `additional context ${context ? "updated" : "removed"} by ${p.id} with the restart`);
          if (notes.length) await this.d.events.normal(updated, "FeedbackSubmitted", `${notes.length} note(s) by ${p.id} with the restart from ${stage ?? "the beginning"}`);
          return updated;
        } catch (e) {
          // The controller may write status at the same time; re-read and try again.
          if (!isStoreError(e, "Conflict") || attempt >= 3) throw e;
        }
      }
    } catch (e) {
      // Nothing re-runs, so the notes stay editable drafts.
      if (notes.length) await this.d.notes?.release(notes, id).catch(() => undefined);
      throw e;
    }
  }

  async publishedPullRequests(_p: Principal, name: string): Promise<PublishedPullRequest[]> {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!wi) throw new StoreError(`work item ${name} not found`, "NotFound");
    const messages = (await this.d.reader.list<OutboxMessage>("OutboxMessage", { namespace: this.ns, ownedBy: { kind: "WorkItem", name, namespace: this.ns } }))
      .filter((m) => m.spec.action === "open-pull-request" && m.status?.phase === "Delivered" && typeof m.status.result?.url === "string")
      .sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? ""));
    const latest = new Map(messages.map((m) => [String(m.spec.payload.workspace), m]));
    const result: PublishedPullRequest[] = [];
    for (const [workspace, m] of latest) {
      const ws = await this.d.reader.get<Workspace>("Workspace", this.ns, workspace);
      const repo = ws && await resolveRef<Repository>(this.d.reader, "Repository", ws.spec.repositoryRef, this.ns);
      const pr: PublishedPullRequest = { workspace, repository: ws?.spec.repositoryRef.name ?? "", url: String(m.status!.result!.url),
        number: Number(m.status!.result!.number), base: repo?.spec.git?.defaultBranch ?? "main", conflicts: [] };
      try {
        if (!ws?.status?.path || !repo) throw new Error("workspace is no longer available");
        if (!this.d.baseConflicts) throw new Error("no base conflict detector is configured");
        pr.conflicts = (await this.d.baseConflicts.detect(ws, repo, pr.base)).conflicts;
      } catch (e) {
        pr.error = this.d.redactor.redact(e instanceof Error ? e.message : String(e));
      }
      result.push(pr);
    }
    return result;
  }

  async updatePullRequest(p: Principal, name: string): Promise<WorkItem> {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
    if (!wi) throw new StoreError(`work item ${name} not found`, "NotFound");
    if (!wi.spec.workflowRef) throw new Error(`work item ${name} has no workflow`);
    if (wi.spec.publicationDisabled) throw new Error("publication is disabled for this work item");
    const wf = await this.d.compiler.compile(wi.spec.workflowRef, this.ns);
    const publish = wf.stages.find((s) => s.publish?.pullRequest);
    if (!publish) throw new Error(`workflow ${wi.spec.workflowRef.name} does not publish pull requests`);
    const index = (stage?: string) => wf.stages.findIndex((s) => s.name === stage);
    if (wi.status?.phase !== "Done" && index(wi.status?.stage) < index(publish.name)) {
      throw new Error(`the item has not reached ${publish.name} yet; it publishes its pull request there`);
    }
    const published = (await this.d.reader.list<OutboxMessage>("OutboxMessage", { namespace: this.ns, ownedBy: { kind: "WorkItem", name, namespace: this.ns } }))
      .some((m) => m.spec.action === "open-pull-request" && typeof m.status?.result?.url === "string");
    if (!published) throw new Error("no pull request was published for this item yet");
    return this.restartWorkItem(p, name, publish.name);
  }

  async addFeedback(p: Principal, workItem: string, input: NewFeedbackInput): Promise<InlineFeedback> {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, workItem);
    if (!wi) throw new Error(`work item ${workItem} not found`);
    const quote = input.quote?.trim();
    const comment = input.comment?.trim();
    if (!quote) throw new Error("select the passage the feedback is about");
    if (!comment) throw new Error("feedback is empty");
    if (comment.length > MAX_COMMENT) throw new Error(`feedback is too long (max ${MAX_COMMENT} characters)`);
    const artifact = await this.d.reader.get<Artifact>("Artifact", this.ns, input.artifact);
    if (!artifact || artifact.spec.workItemRef.name !== workItem) throw new Error(`artifact ${input.artifact} does not belong to ${workItem}`);
    // Replays never advance the workflow (ADR-0012), so there is no step that could act on feedback about them.
    if (artifact.metadata.labels?.["factory.ai-dlc.io/replay"]) throw new Error("feedback on a replay's output can't reach an agent; comment on the original");
    const runRef = artifact.spec.producedBy?.agentRunRef;
    const run = runRef ? await this.d.reader.get<AgentRun>("AgentRun", this.ns, runRef.name) : null;
    if (!run) throw new Error("the run that produced this artifact no longer exists");
    return this.d.writer.create<InlineFeedback>({
      apiVersion: API_VERSION,
      kind: "InlineFeedback",
      metadata: {
        name: "",
        generateName: `${artifact.metadata.name.slice(0, 50)}-fb-`,
        namespace: this.ns,
        ownerReferences: [ownerRef(wi)],
        labels: { [LABEL_WORKITEM]: workItem },
      },
      spec: {
        workItemRef: { name: workItem },
        targetRef: { name: artifact.metadata.name },
        producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: run.spec.agentRef, stage: run.spec.stage, step: run.spec.step },
        quote: quote.slice(0, MAX_QUOTE),
        comment,
        author: p.id,
      },
    });
  }

  async updateFeedback(_p: Principal, name: string, comment: string): Promise<InlineFeedback> {
    const f = await this.draftOrThrow(name);
    const text = comment?.trim();
    if (!text) throw new Error("feedback is empty");
    if (text.length > MAX_COMMENT) throw new Error(`feedback is too long (max ${MAX_COMMENT} characters)`);
    return this.d.writer.update<InlineFeedback>({ ...f, spec: { ...f.spec, comment: text } });
  }

  async deleteFeedback(_p: Principal, name: string): Promise<void> {
    await this.draftOrThrow(name);
    await this.d.writer.delete("InlineFeedback", this.ns, name);
  }

  async submitFeedback(p: Principal, workItem: string): Promise<FeedbackPlan> {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, workItem);
    if (!wi) throw new Error(`work item ${workItem} not found`);
    if (!wi.spec.workflowRef) throw new Error(`work item ${workItem} has no workflow`);
    const owned = { kind: "WorkItem", name: workItem, namespace: this.ns };
    const drafts = (await this.d.reader.list<InlineFeedback>("InlineFeedback", { namespace: this.ns, ownedBy: owned })).filter((f) => !f.spec.submitted);
    const open = wi.status?.blockedBy?.kind === "Approval" ? await this.d.reader.get<Approval>("Approval", this.ns, wi.status.blockedBy.name) : null;
    const plan = planFeedbackSubmission(drafts, wi, await this.d.compiler.compile(wi.spec.workflowRef, this.ns), open ?? undefined);
    // Mark first: the re-run triggered below must already see the notes as submitted.
    const submitted = { id: randomUUID(), at: new Date().toISOString(), by: p.id };
    const marked: string[] = [];
    try {
      for (const f of drafts) {
        await this.d.writer.update<InlineFeedback>({ ...f, spec: { ...f.spec, submitted } });
        marked.push(f.metadata.name);
      }
      if (plan.action === "reject") {
        await this.decideApproval(p, plan.approval!, "reject", `Changes requested through ${drafts.length} inline feedback note(s) (see "Human feedback").`);
      } else {
        await this.restartWorkItem(p, workItem, plan.stage);
      }
    } catch (e) {
      // Nothing re-runs, so the notes must stay editable drafts (e.g. the gate was decided meanwhile).
      await this.unmarkFeedback(marked, submitted.id);
      throw e;
    }
    await this.d.events.normal(
      wi,
      "FeedbackSubmitted",
      `${drafts.length} note(s) for ${plan.agents.join(", ")} by ${p.id}: ${plan.action === "reject" ? `changes requested at ${open?.spec.stage}` : "restart"} → ${plan.stage}`,
    );
    return plan;
  }

  private async unmarkFeedback(names: string[], batch: string) {
    for (const name of names) {
      const f = await this.d.reader.get<InlineFeedback>("InlineFeedback", this.ns, name);
      if (f?.spec.submitted?.id === batch) await this.d.writer.update<InlineFeedback>({ ...f, spec: { ...f.spec, submitted: undefined } });
    }
  }

  private async draftOrThrow(name: string): Promise<InlineFeedback> {
    const f = await this.d.reader.get<InlineFeedback>("InlineFeedback", this.ns, name);
    if (!f) throw new Error(`feedback ${name} not found`);
    if (f.spec.submitted) throw new Error("submitted feedback can't be changed");
    return f;
  }

  async listKnowledge(_p: Principal): Promise<KnowledgeEntry[]> {
    return (await this.d.reader.list<KnowledgeEntry>("KnowledgeEntry", { namespace: this.ns })).sort((a, b) =>
      (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
    );
  }

  async getKnowledge(_p: Principal, name: string): Promise<KnowledgeDetail | null> {
    const entry = await this.d.reader.get<KnowledgeEntry>("KnowledgeEntry", this.ns, name);
    if (!entry) return null;
    const conversations = await this.d.reader.list<Conversation>("Conversation", {
      namespace: this.ns,
      ownedBy: { kind: "KnowledgeEntry", name, namespace: this.ns },
    });
    return { entry, conversations };
  }

  async updateKnowledge(p: Principal, name: string, patch: { title?: string; content?: string; tags?: string[] }): Promise<KnowledgeEntry> {
    const e = await this.knowledgeOrThrow(name);
    if (e.spec.retired) throw new Error("retired entries can't be edited");
    const title = patch.title !== undefined ? patch.title.trim() : e.spec.title;
    const content = patch.content !== undefined ? patch.content.trim() : e.spec.content;
    if (!title || !content) throw new Error("title and content are required");
    const tags = patch.tags !== undefined ? [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] : e.spec.tags;
    // Approval always comes first (ADR-0030): any change, also an applied agent draft, goes back to review.
    const updated = await this.d.writer.update<KnowledgeEntry>({ ...e, spec: { ...e.spec, title, content, tags, review: undefined } });
    await this.d.events.normal(updated, "Edited", `by ${p.id}`);
    return updated;
  }

  async reviewKnowledge(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<KnowledgeEntry> {
    if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
    const e = await this.knowledgeOrThrow(name);
    if (e.spec.retired) throw new Error("retired entries can't be reviewed");
    return this.d.writer.update<KnowledgeEntry>({
      ...e,
      spec: { ...e.spec, review: { decision, by: p.id, at: new Date().toISOString(), comment: comment?.trim() || undefined } },
    });
  }

  async retireKnowledge(_p: Principal, name: string): Promise<KnowledgeEntry> {
    const e = await this.knowledgeOrThrow(name);
    return this.d.writer.update<KnowledgeEntry>({ ...e, spec: { ...e.spec, retired: true } });
  }

  async proposeKnowledge(
    p: Principal,
    input: { title: string; content: string; tags?: string[]; repositories?: string[]; workflows?: string[] },
  ): Promise<KnowledgeEntry> {
    const title = input.title?.trim();
    const content = input.content?.trim();
    if (!title || !content) throw new Error("title and content are required");
    if (content.length > 20_000) throw new Error("content is too long (max 20000 characters)");
    return this.d.writer.create<KnowledgeEntry>({
      apiVersion: API_VERSION,
      kind: "KnowledgeEntry",
      metadata: { name: `kb-${slug(title).slice(0, 40)}-${randomUUID().slice(0, 6)}`, namespace: this.ns },
      spec: {
        title: title.slice(0, 200),
        content,
        tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10),
        scope: { repositories: input.repositories?.length ? input.repositories : undefined, workflows: input.workflows?.length ? input.workflows : undefined },
        provenance: { proposedBy: p.id, proposedAt: new Date().toISOString() },
      },
    });
  }

  async startKnowledgeConversation(p: Principal, name: string): Promise<Conversation> {
    const e = await this.knowledgeOrThrow(name);
    const created = await this.d.writer.create<Conversation>({
      apiVersion: API_VERSION,
      kind: "Conversation",
      metadata: { name: "", generateName: `${name.slice(0, 50)}-refine-`, namespace: this.ns, ownerReferences: [ownerRef(e)] },
      spec: {
        knowledgeRef: { name },
        // Only if the agent still exists; the responder works without a persona otherwise.
        agentRef: e.spec.provenance?.agent && (await resolveRef(this.d.reader, "Agent", { name: e.spec.provenance.agent }, this.ns)) ? { name: e.spec.provenance.agent } : undefined,
        purpose: "refine-knowledge",
        startedBy: p.id,
      },
    });
    return this.awaitTranscript(created);
  }

  private async knowledgeOrThrow(name: string): Promise<KnowledgeEntry> {
    const e = await this.d.reader.get<KnowledgeEntry>("KnowledgeEntry", this.ns, name);
    if (!e) throw new Error(`knowledge entry ${name} not found`);
    return e;
  }

  /** ADR-0029: after a restart, an old round's open clarification/approval no longer steers the item. */
  private async assertCurrentBlocker(workItem: string, name: string) {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, workItem);
    if (wi?.status?.blockedBy?.name !== name) throw new Error(`${name} is no longer open: the work item has moved on (e.g. it was restarted)`);
  }

  async updateWorkItemContext(p: Principal, name: string, context: string): Promise<WorkItem> {
    if (typeof context !== "string") throw new Error("context must be text");
    if (context.length > MAX_CONTEXT) throw new Error(`context is too long (max ${MAX_CONTEXT} characters)`);
    for (let attempt = 0; ; attempt++) {
      const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
      if (!wi) throw new Error(`work item ${name} not found`);
      const available = MAX_CONTEXT - (wi.spec.originSnapshot?.content.length ?? 0);
      if (context.length > available) throw new Error(`context is too long (max ${available} characters alongside inherited evidence)`);
      try {
        const updated = await this.d.writer.update<WorkItem>({ ...wi, spec: { ...wi.spec, context: context.trim() || undefined } });
        await this.d.events.normal(updated, "ContextUpdated", `additional context ${context.trim() ? "updated" : "removed"} by ${p.id}`);
        return updated;
      } catch (e) {
        // The controller may write status at the same time; re-read and try again.
        if (!isStoreError(e, "Conflict") || attempt >= 3) throw e;
      }
    }
  }

  async deleteWorkItem(_p: Principal, name: string): Promise<void> {
    await this.d.writer.delete("WorkItem", this.ns, name);
  }

  async answerClarification(p: Principal, name: string, answers: string[]): Promise<Clarification> {
    const c = await this.d.reader.get<Clarification>("Clarification", this.ns, name);
    if (!c) throw new Error(`clarification ${name} not found`);
    if (c.spec.answers?.length) throw new Error("already answered");
    await this.assertCurrentBlocker(c.spec.workItemRef.name, name);
    // Positional: answer i belongs to question i; skipped questions are explicit so the agent can tell them apart.
    // "(no answer)" is a legitimate answer ("I don't know"); the agent then proceeds with stated assumptions.
    if (!Array.isArray(answers) || answers.length === 0) throw new Error("answers are required");
    const cleaned = c.spec.questions.map((_, i) => (answers[i] ?? "").trim() || "(no answer)");
    return this.d.writer.update({ ...c, spec: { ...c.spec, answers: cleaned, answeredBy: p.id } });
  }

  async decideApproval(p: Principal, name: string, decision: "approve" | "reject", comment?: string, override?: boolean, verdict?: ReviewVerdict): Promise<Approval> {
    const a = await this.d.reader.get<Approval>("Approval", this.ns, name);
    if (!a) throw new Error(`approval ${name} not found`);
    if (a.spec.recoveryAllowance) throw new Error("Use the operator recovery allowance decision endpoint.");
    if (a.spec.decision) throw new Error("already decided");
    await this.assertCurrentBlocker(a.spec.workItemRef.name, name);
    for (const guard of this.d.approvalGuards ?? []) await guard.validate(a, decision);
    if (a.spec.retrospective && !this.d.approvalGuards?.length) throw new Error("retrospective approval guard is unavailable");
    if (a.spec.verification) {
      if (!this.d.verificationGuard) throw new Error("verification approval guard is unavailable");
      await this.d.verificationGuard.validate(a, decision, comment);
    }
    if (decision === "approve") {
      if (a.spec.ticketPublication) throw new Error("Use the publication review to explicitly approve the response, visibility and optional ticket transition");
      // ADR-0027: failing evidence can't be approved by accident — enforced here, not only in the UI.
      const owned = { kind: "WorkItem", name: a.spec.workItemRef.name, namespace: this.ns };
      const [runs, events, clarifications, artifacts] = await Promise.all([
        this.d.reader.list<AgentRun>("AgentRun", { namespace: this.ns, ownedBy: owned }),
        this.d.reader.list<FactoryEvent>("Event", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: a.spec.workItemRef.name } }),
        this.d.reader.list<Clarification>("Clarification", { namespace: this.ns, ownedBy: owned }),
        this.d.reader.list<Artifact>("Artifact", { namespace: this.ns, ownedBy: owned }),
      ]);
      const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, a.spec.workItemRef.name);
      const verified = !!wi?.spec.workflowRef && !!(await this.d.compiler.compile(wi.spec.workflowRef, this.ns)).verification;
      const evidence = deriveGateEvidence({ runs, events, clarifications, artifacts, verified });
      const guardedSeparately = a.spec.verification?.kind === "waiver";
      if (evidence.status === "blocking" && !guardedSeparately) {
        const reasons = evidence.items.filter((i) => i.severity === "blocking").map((i) => i.label).join("; ");
        if (!override) throw new Error(`blocking evidence (${reasons}); approving requires an explicit override with a reason`);
        if (!comment || comment.trim().length < 10) throw new Error("an override needs a reason (at least 10 characters)");
        if (wi) await this.d.events.warning(wi, "ApprovedDespiteFailures", `${a.spec.stage} approved by ${p.id} despite: ${reasons}. Reason: ${comment.trim()}`);
      }
    }
    if (verdict !== undefined) {
      if (decision !== "approve") throw new Error("a review verdict can only be set when approving");
      if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
      const item = await this.d.reader.get<WorkItem>("WorkItem", this.ns, a.spec.workItemRef.name);
      if (!item?.spec.pullRequest) throw new Error("a review verdict applies only to pull request review items");
    }
    const overridden = decision === "approve" && override === true ? true : undefined;
    const updated = await this.d.writer.update({ ...a, spec: { ...a.spec, decision, decidedBy: p.id, comment, ...(overridden ? { overridden } : {}), ...(verdict ? { prReview: { verdict } } : {}) } });
    if (decision === "approve" && a.spec.verification?.kind === "waiver") {
      const item = await this.d.reader.get<WorkItem>("WorkItem", this.ns, a.spec.workItemRef.name);
      if (item) await this.d.events.warning(item, "VerificationWaived", `Waived, not Passed: ${a.spec.verification.requirements?.join(", ")}. By ${p.id}: ${comment}`);
    }
    return updated;
  }

  async listIssueTargets(_p: Principal) {
    return (await this.listSources(_p))
      .filter((s) => s.spec.writeBack?.issues)
      .map((s) => ({ source: s.metadata.name, type: s.spec.type, project: s.spec.writeBack?.issues?.project, issueType: s.spec.writeBack?.issues?.issueType, labels: s.spec.writeBack?.issues?.labels }));
  }

  async proposeIssue(p: Principal, input: { title: string; body: string; issueType?: string; labels?: string[]; workItem?: string }): Promise<{ name: string }> {
    const title = input.title?.trim();
    const body = input.body?.trim();
    if (!title || !body) throw new Error("title and body are required");
    if (body.length > 20_000) throw new Error("body is too long (max 20000 characters)");
    if (!input.workItem) throw new Error("workItem is required");
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, input.workItem);
    if (!wi) throw new Error(`work item ${input.workItem} not found`);
    const r = this.d.redactor;
    const created = await this.d.writer.create<IssueProposal>({
      apiVersion: API_VERSION,
      kind: "IssueProposal",
      metadata: { name: `issue-${slug(title).slice(0, 40)}-${randomUUID().slice(0, 6)}`, namespace: this.ns, ...(wi ? { ownerReferences: [ownerRef(wi)] } : {}) },
      spec: {
        purpose: "finding",
        title: r.redact(title).slice(0, 200),
        body: r.redact(body),
        ...(input.issueType?.trim() ? { issueType: r.redact(input.issueType.trim()) } : {}),
        ...(input.labels?.length ? { labels: input.labels.map((l) => r.redact(l.trim())).filter(Boolean).slice(0, 10) } : {}),
        pickUp: false,
        provenance: { proposedBy: p.id, workItem: wi?.metadata.name, proposedAt: new Date().toISOString() },
      },
    });
    return { name: created.metadata.name };
  }

  async listSources(_p: Principal): Promise<Source[]> {
    return this.d.reader.list<Source>("Source", { namespace: SYSTEM_NAMESPACE });
  }

  syncSource(_p: Principal, name: string) {
    return this.d.syncer.sync(name);
  }

  async runTranscript(_p: Principal, runName: string): Promise<TranscriptMessage[]> {
    const run = await this.d.reader.get<AgentRun>("AgentRun", this.ns, runName);
    if (!run?.status?.transcriptRef) return [];
    return this.d.transcripts.read(run.status.transcriptRef);
  }

  async startConversation(p: Principal, runName: string): Promise<Conversation> {
    const run = await this.d.reader.get<AgentRun>("AgentRun", this.ns, runName);
    if (!run) throw new Error(`run ${runName} not found`);
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, run.spec.workItemRef.name);
    if (!wi) throw new Error("work item not found");
    const created = await this.d.writer.create<Conversation>({
      apiVersion: API_VERSION,
      kind: "Conversation",
      metadata: { name: "", generateName: `${runName.slice(0, 50)}-chat-`, namespace: this.ns, ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: wi.metadata.name }, agentRunRef: { name: runName }, agentRef: run.spec.agentRef, purpose: "explain", startedBy: p.id },
    });
    // The conversation controller opens the transcript; wait briefly so the UI can chat immediately.
    return this.awaitTranscript(created);
  }

  async startItemConversation(p: Principal, workItem: string): Promise<Conversation> {
    const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, workItem);
    if (!wi) throw new Error(`work item ${workItem} not found`);
    const created = await this.d.writer.create<Conversation>({
      apiVersion: API_VERSION,
      kind: "Conversation",
      metadata: { name: "", generateName: `${workItem.slice(0, 50)}-ask-`, namespace: this.ns, ownerReferences: [ownerRef(wi)] },
      spec: { workItemRef: { name: workItem }, purpose: "explain-item", startedBy: p.id },
    });
    return this.awaitTranscript(created);
  }

  private async awaitTranscript(created: Conversation): Promise<Conversation> {
    for (let i = 0; i < 100; i++) {
      const c = await this.d.reader.get<Conversation>("Conversation", this.ns, created.metadata.name);
      if (c?.status?.transcriptRef) return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    return created;
  }

  async conversationMessages(_p: Principal, name: string): Promise<TranscriptMessage[]> {
    const c = await this.d.reader.get<Conversation>("Conversation", this.ns, name);
    return c?.status?.transcriptRef ? this.d.transcripts.read(c.status.transcriptRef) : [];
  }

  async sendMessage(p: Principal, name: string, text: string): Promise<TranscriptMessage> {
    const c = await this.d.reader.get<Conversation>("Conversation", this.ns, name);
    if (!c) throw new Error(`conversation ${name} not found`);
    if (c.spec.purpose === "agent-chat") throw new Error("use the durable agent chat turn endpoint");
    if (!text.trim()) throw new Error("message is empty");
    const responder = this.d.responders.get(c.spec.purpose ?? "explain"); // pre-ADR-0026 conversations had no purpose
    if (!responder) throw new Error(`no responder for conversation purpose "${c.spec.purpose}"`);
    return responder.respond(c, text.trim(), { type: "human", id: p.id });
  }

  /** MVP: one runtime namespace + factory-system. v0.4 derives these from the principal's squads (ADR-0009/0011). */
  private nsFor(scope: "definition" | "runtime"): string {
    return scope === "runtime" ? this.ns : SYSTEM_NAMESPACE;
  }

  private kindByPlural(plural: string) {
    const info = this.d.kinds.byPlural(plural);
    if (!info) throw new Error(`unknown resource type ${plural}`);
    return info;
  }

  async browsableKinds(_p: Principal): Promise<BrowsableKind[]> {
    return Promise.all(
      this.d.kinds.all().map(async (k) => ({
        kind: k.kind,
        plural: k.plural,
        scope: k.scope,
        count: (await this.d.reader.list(k.kind, { namespace: this.nsFor(k.scope) })).length,
      })),
    );
  }

  async listResources(_p: Principal, plural: string): Promise<Resource[]> {
    const k = this.kindByPlural(plural);
    const list = await this.d.reader.list(k.kind, { namespace: this.nsFor(k.scope) });
    return list.sort((a, b) => (b.metadata.creationTimestamp ?? b.metadata.name).localeCompare(a.metadata.creationTimestamp ?? a.metadata.name));
  }

  async getResource(_p: Principal, plural: string, name: string): Promise<Resource | null> {
    const k = this.kindByPlural(plural);
    return this.d.reader.get(k.kind, this.nsFor(k.scope), name);
  }

  async systemHealth(_p: Principal): Promise<SystemHealth> {
    const sel = await this.d.environments.select();
    const m = await this.d.models.resolve({ namespace: this.ns, tier: "reasoning" });
    return {
      sandbox: sel.health,
      sandboxCandidates: sel.candidates,
      llm: m ? { available: true, provider: m.provider, model: m.model } : { available: false },
      simulation: this.d.simulation,
      failing: this.d.controllerHealth.failing(),
      policyGaps: (await this.d.reader.list<Repository>("Repository")).flatMap(verificationPolicyGaps),
      checks: this.d.checkWorkers ? await this.d.checkWorkers() : { workers: 0, running: 0 },
      role: this.d.role ?? "all",
      toolGaps: this.d.toolGaps ? await this.d.toolGaps() : [],
    };
  }

  async rerun(_p: Principal, runName: string): Promise<AgentRun> {
    const run = await this.d.reader.get<AgentRun>("AgentRun", this.ns, runName);
    if (!run) throw new Error(`run ${runName} not found`);
    await this.assertNoActiveChecks(run.spec.workItemRef.name);
    if (run.status?.phase !== "Succeeded" && run.status?.phase !== "Failed") throw new Error("only finished runs can be re-run");
    return this.d.replayer.rerun(run);
  }

  private async assertNoActiveChecks(name: string) {
    const checks = await this.d.reader.list<import("../model/kinds.ts").CheckRun>("CheckRun", {
      namespace: this.ns, ownedBy: { kind: "WorkItem", name, namespace: this.ns },
    });
    if (checks.some((check) => !check.status || check.status.phase === "Running")) {
      throw new StoreError("wait for the standalone check to finish before restarting or replaying agents", "Conflict");
    }
  }

  async listDefinitions(_p: Principal, kind: string): Promise<Resource[]> {
    if (this.d.kinds.byKind(kind)?.scope !== "definition") throw new Error(`${kind} is not a definition kind`);
    return this.d.reader.list(kind);
  }
}
