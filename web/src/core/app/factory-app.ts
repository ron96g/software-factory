import type {
  AgentRun,
  Approval,
  Artifact,
  Clarification,
  Conversation,
  FactoryEvent,
  Source,
  WorkItem,
} from "../model/kinds.ts";
import { API_VERSION, DEFAULT_NAMESPACE, SYSTEM_NAMESPACE, type Resource } from "../model/resource.ts";
import { ownerRef } from "../model/meta.ts";
import type {
  ConversationActions,
  ConversationResponder,
  DefinitionQueries,
  HumanActions,
  KindLookup,
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
} from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";

export interface FactoryAppDeps {
  reader: ResourceReader;
  writer: ResourceWriter;
  kinds: KindLookup;
  compiler: WorkflowCompiler;
  syncer: SourceSyncer;
  transcripts: TranscriptReader;
  responder: ConversationResponder;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "item";

/**
 * Use cases behind the API. Every method takes a Principal (ADR-0009); authorization
 * and namespace scoping plug in here in v0.4. MVP: single namespace `default`.
 */
export class FactoryApp
  implements WorkItemQueries, WorkItemCommands, HumanActions, SourceActions, TranscriptQueries, ConversationActions, DefinitionQueries
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
    const [runs, artifacts, clarifications, approvals, conversations, events] = await Promise.all([
      this.d.reader.list<AgentRun>("AgentRun", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Artifact>("Artifact", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Clarification>("Clarification", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Approval>("Approval", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<Conversation>("Conversation", { namespace: this.ns, ownedBy: owned }),
      this.d.reader.list<FactoryEvent>("Event", { namespace: this.ns, labelSelector: { [LABEL_WORKITEM]: name } }),
    ]);
    let stages: WorkItemDetail["stages"] = [];
    if (workItem.spec.workflowRef) {
      try {
        const wf = await this.d.compiler.compile(workItem.spec.workflowRef, this.ns);
        stages = wf.stages.map((s) => ({ name: s.name, lifecyclePhase: s.lifecyclePhase, gate: s.gate?.type }));
      } catch {
        // a broken workflow is surfaced through the item's status
      }
    }
    return { workItem, runs, artifacts, clarifications, approvals, conversations, events, stages };
  }

  async createWorkItem(p: Principal, input: NewWorkItemInput): Promise<WorkItem> {
    if (!input.title?.trim()) throw new Error("title is required");
    const base = slug(input.title);
    let name = base;
    for (let i = 2; await this.d.reader.get("WorkItem", this.ns, name); i++) name = `${base}-${i}`;
    return this.d.writer.create<WorkItem>({
      apiVersion: API_VERSION,
      kind: "WorkItem",
      metadata: { name, namespace: this.ns, annotations: { "factory.ai-dlc.io/created-by": p.id } },
      spec: {
        title: input.title.trim(),
        description: input.description?.trim(),
        sourceRef: { name: "manual" },
        repositoryRefs: input.repositoryRefs?.length ? input.repositoryRefs.map((name) => ({ name })) : undefined,
      },
    });
  }

  async answerClarification(p: Principal, name: string, answers: string[]): Promise<Clarification> {
    const c = await this.d.reader.get<Clarification>("Clarification", this.ns, name);
    if (!c) throw new Error(`clarification ${name} not found`);
    if (c.spec.answers?.length) throw new Error("already answered");
    const cleaned = answers.map((a) => a.trim()).filter(Boolean);
    if (!cleaned.length) throw new Error("an answer is required");
    return this.d.writer.update({ ...c, spec: { ...c.spec, answers: cleaned, answeredBy: p.id } });
  }

  async decideApproval(p: Principal, name: string, decision: "approve" | "reject", comment?: string): Promise<Approval> {
    const a = await this.d.reader.get<Approval>("Approval", this.ns, name);
    if (!a) throw new Error(`approval ${name} not found`);
    if (a.spec.decision) throw new Error("already decided");
    return this.d.writer.update({ ...a, spec: { ...a.spec, decision, decidedBy: p.id, comment } });
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
    if (!text.trim()) throw new Error("message is empty");
    return this.d.responder.respond(c, text.trim(), { type: "human", id: p.id });
  }

  async listDefinitions(_p: Principal, kind: string): Promise<Resource[]> {
    if (this.d.kinds.byKind(kind)?.scope !== "definition") throw new Error(`${kind} is not a definition kind`);
    return this.d.reader.list(kind);
  }
}
