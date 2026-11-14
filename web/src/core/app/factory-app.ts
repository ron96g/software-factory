import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  KnowledgeEntry,
  Repository,
  Source,
  WorkItem,
  Workflow,
  Workspace,
  OutboxMessage,
} from "../model/kinds.ts";
import { resolveRef } from "../refs/refs.ts";
import { API_VERSION, DEFAULT_NAMESPACE, SYSTEM_NAMESPACE, type Resource } from "../model/resource.ts";
import { ownerRef } from "../model/meta.ts";
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
  ItemConversationActions,
  Lookup,
  KindLookup,
  KnowledgeActions,
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
  NewFollowUpInput,
  FollowUpRelations,
  VerificationApprovalGuard,
} from "../ports/index.ts";
import { isStoreError, StoreError } from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";
import { deriveGateEvidence } from "./gate-evidence.ts";
import { fingerprint, followUpPreview, FOLLOW_UP_INPUT, LABEL_ORIGIN_UID } from "./work-item-followups.ts";

export interface FactoryAppDeps {
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
  /** Audit trail for human overrides (ADR-0027) — required, an override must never go unlogged. */
  events: EventRecorder;
  /** ADR-0029 policy, reported in system health. */
  simulation: "allow" | "wait";
  redactor: Redactor;
  records: WorkItemRecordReader;
  clock: Clock;
}

const MAX_CONTEXT = 20_000;

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
    AgentChatQueries,
    AgentChatCommands,
    ChatWorkItemCreator,
    WorkItemFollowUpQueries,
    WorkItemFollowUpCommands
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
    const [runs, artifacts, clarifications, approvals, conversations, workspaces, outbox, events] = await Promise.all([
      this.d.reader.list<AgentRun>("AgentRun", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Artifact>("Artifact", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Clarification>("Clarification", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Approval>("Approval", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Conversation>("Conversation", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Workspace>("Workspace", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<OutboxMessage>("OutboxMessage", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<FactoryEvent>("Event", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: name } }),
    ]);
    let stages: WorkItemDetail["stages"] = [];
    let verified = false;
    if (workItem.spec.workflowRef) {
      try {
        const wf = await this.d.compiler.compile(workItem.spec.workflowRef, this.ns);
        verified = !!wf.verification;
        stages = wf.stages.map((s) => ({ name: s.name, lifecyclePhase: s.lifecyclePhase, gate: s.gate?.type }));
      } catch {
        // a broken workflow is surfaced through the item's status
      }
    }
    const evidence = deriveGateEvidence({ runs, events, clarifications, artifacts, verified });
    const knowledge = await this.d.reader.list<KnowledgeEntry>("KnowledgeEntry", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: name } });
    return { workItem, runs, artifacts, clarifications, approvals, conversations, workspaces, outbox, evidence, events, stages, knowledge };
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
    return {
      workflows: workflows.filter((w) => !subWorkflows.has(w.metadata.name)).map(describe),
      repositories: repositories.filter((r) => !!r.spec.local?.path).map(describe),
      defaults: {
        workflow: manual?.spec.defaults?.workflowRef?.name,
        repositories: (manual?.spec.defaults?.repositoryRefs ?? []).map((r) => r.name),
      },
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
      return await this.d.writer.create(item);
    } catch (e) {
      if (!origin || !isStoreError(e, "AlreadyExists")) throw e;
      const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
      if (existing?.spec.conversationRef?.name !== origin.metadata.name) throw e;
      return existing;
    }
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
    const hash = fingerprint([this.ns, name, cleaned.requestId, cleaned.expectedRevision, cleaned.title, cleaned.description, cleaned.context, cleaned.workflowRef, cleaned.repositoryRefs]);
    const target = `followup-${input.requestId}`;
    const existing = await this.d.reader.get<WorkItem>("WorkItem", this.ns, target);
    if (existing) {
      if (existing.metadata.annotations?.[FOLLOW_UP_INPUT] !== hash) throw new StoreError("requestId was already used with different follow-up input", "Conflict");
      return existing;
    }
    const preview = await this.previewWorkItemFollowUp(p, name, cleaned.context);
    if (preview.revision !== input.expectedRevision) throw new StoreError("Origin evidence or instructions changed. Refresh the context preview before creating the follow-up.", "Conflict");
    const item = await this.newItem(p, cleaned);
    item.metadata.name = target;
    item.metadata.labels = { [LABEL_ORIGIN_UID]: preview.snapshot.uid };
    item.metadata.annotations = { ...item.metadata.annotations, [FOLLOW_UP_INPUT]: hash };
    item.spec.context = preview.instructions || undefined;
    item.spec.originWorkItemRef = { name };
    item.spec.originSnapshot = preview.snapshot;
    try {
      return await this.d.writer.create(item);
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
      const duplicate = await this.d.reader.get<WorkItem>("WorkItem", this.ns, target);
      if (duplicate?.metadata.annotations?.[FOLLOW_UP_INPUT] !== hash) throw new StoreError("requestId was already used with different follow-up input", "Conflict");
      return duplicate;
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

  async restartWorkItem(p: Principal, name: string, stage?: string): Promise<WorkItem> {
    await this.assertNoActiveChecks(name);
    for (let attempt = 0; ; attempt++) {
      const wi = await this.d.reader.get<WorkItem>("WorkItem", this.ns, name);
      if (!wi) throw new Error(`work item ${name} not found`);
      if (stage) {
        if (!wi.spec.workflowRef) throw new Error(`work item ${name} has no workflow`);
        const wf = await this.d.compiler.compile(wi.spec.workflowRef, this.ns);
        if (!wf.stage(stage)) throw new Error(`stage "${stage}" not found in workflow ${wi.spec.workflowRef.name}`);
      }
      try {
        return await this.d.writer.update<WorkItem>({ ...wi, spec: { ...wi.spec, restart: { id: randomUUID(), stage, requestedBy: p.id } } });
      } catch (e) {
        // The controller may write status at the same time; re-read and try again.
        if (!isStoreError(e, "Conflict") || attempt >= 3) throw e;
      }
    }
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

  async decideApproval(p: Principal, name: string, decision: "approve" | "reject", comment?: string, override?: boolean): Promise<Approval> {
    const a = await this.d.reader.get<Approval>("Approval", this.ns, name);
    if (!a) throw new Error(`approval ${name} not found`);
    if (a.spec.decision) throw new Error("already decided");
    await this.assertCurrentBlocker(a.spec.workItemRef.name, name);
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
    const overridden = decision === "approve" && override === true ? true : undefined;
    const updated = await this.d.writer.update({ ...a, spec: { ...a.spec, decision, decidedBy: p.id, comment, ...(overridden ? { overridden } : {}) } });
    if (decision === "approve" && a.spec.verification?.kind === "waiver") {
      const item = await this.d.reader.get<WorkItem>("WorkItem", this.ns, a.spec.workItemRef.name);
      if (item) await this.d.events.warning(item, "VerificationWaived", `Waived, not Passed: ${a.spec.verification.requirements?.join(", ")}. By ${p.id}: ${comment}`);
    }
    return updated;
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
