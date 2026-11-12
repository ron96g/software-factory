import type {
  ExposedTool,
  HumanActions,
  KnowledgeActions,
  KnowledgeSearcher,
  Principal,
  SourceActions,
  WorkItemCommands,
  WorkItemQueries,
} from "../ports/index.ts";

type Args = Record<string, unknown>;

const str = (a: Args, k: string, required = true): string | undefined => {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`argument "${k}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`argument "${k}" must be a string`);
  return v;
};
const strs = (a: Args, k: string): string[] | undefined => {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`argument "${k}" must be a list of strings`);
  return v as string[];
};
const clip = (s: string | undefined, n: number) => (!s ? s : s.length > n ? `${s.slice(0, n)} …[truncated]` : s);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const S = (description: string) => ({ type: "string", description });
const LIST = (description: string) => ({ type: "array", items: { type: "string" }, description });

export interface FactoryToolDeps {
  items: WorkItemQueries & WorkItemCommands;
  /** Only `answerClarification` is used: gates (decideApproval) are never exposed (rule 8). */
  answers: Pick<HumanActions, "answerClarification">;
  sources: SourceActions;
  knowledge: Pick<KnowledgeActions, "proposeKnowledge">;
  search: KnowledgeSearcher;
}

/**
 * ADR-0034: what an external agent harness may do via MCP. Everything goes through the app commands (same admission,
 * events and rules as the UI). Not offered on purpose: approving/rejecting gates, approving knowledge, deleting.
 */
export function factoryTools(d: FactoryToolDeps): ExposedTool[] {
  const tool = (t: ExposedTool) => t;
  return [
    tool({
      name: "list_work_items",
      description: "List work items with their phase and stage. Optional filter by phase (e.g. Blocked, AwaitingApproval, Waiting, Running, Done).",
      inputSchema: obj({ phase: S("only items in this phase") }),
      annotations: { readOnlyHint: true },
      async invoke(p, a) {
        const phase = str(a, "phase", false);
        return (await d.items.listWorkItems(p))
          .filter((w) => !phase || (w.status?.phase ?? "New") === phase)
          .map((w) => ({
            name: w.metadata.name,
            title: w.spec.title,
            phase: w.status?.phase ?? "New",
            stage: w.status?.stage,
            workflow: w.spec.workflowRef?.name,
            source: w.spec.sourceRef.name,
            external: w.spec.externalRef?.url,
          }));
      },
    }),
    tool({
      name: "get_work_item",
      description:
        "Get one work item: description, additional context, status, open questions (when Blocked), the gate it waits for, " +
        "the latest artifact of each type (truncated), and recent events.",
      inputSchema: obj({ name: S("work item name") }, ["name"]),
      annotations: { readOnlyHint: true },
      async invoke(p, a) {
        const x = await d.items.getWorkItem(p, str(a, "name")!);
        if (!x) throw new Error(`work item ${String(a.name)} not found`);
        const st = x.workItem.status;
        const latest = new Map<string, (typeof x.artifacts)[number]>();
        for (const art of x.artifacts) if (!art.metadata.labels?.["factory.ai-dlc.io/replay"]) latest.set(art.spec.artifactTypeRef.name, art);
        const open = x.clarifications.find((c) => c.metadata.name === st?.blockedBy?.name && st?.phase === "Blocked");
        const gate = x.approvals.find((g) => g.metadata.name === st?.blockedBy?.name && st?.phase === "AwaitingApproval");
        return {
          name: x.workItem.metadata.name,
          title: x.workItem.spec.title,
          description: clip(x.workItem.spec.description, 6000),
          context: x.workItem.spec.context,
          workflow: x.workItem.spec.workflowRef?.name,
          repositories: (x.workItem.spec.repositoryRefs ?? []).map((r) => r.name),
          phase: st?.phase ?? "New",
          stage: st?.stage,
          message: st?.message,
          openQuestions: open ? open.spec.questions : undefined,
          awaitingApproval: gate ? { stage: gate.spec.stage, note: "Approve or reject in the factory UI (not available via MCP)." } : undefined,
          stages: x.stages.map((s) => s.name),
          artifacts: [...latest.values()].map((art) => ({ type: art.spec.artifactTypeRef.name, by: art.spec.producedBy?.agentRef.name, content: clip(art.spec.content, 4000) })),
          knowledge: x.knowledge.map((k) => ({ name: k.metadata.name, title: k.spec.title, phase: k.status?.phase ?? "Proposed" })),
          recentEvents: x.events.slice(-10).map((e) => `${e.metadata.creationTimestamp ?? ""} ${e.spec.reason}: ${clip(e.spec.message, 200)}`),
        };
      },
    }),
    tool({
      name: "create_work_item",
      humanOnly: true,
      description: "Create a work item (source: manual). Optional workflow and repositories (defaults apply) and additional context for the agents.",
      inputSchema: obj(
        { title: S("short title"), description: S("what and why"), context: S("additional context agents should know up front"), workflow: S("workflow name"), repositories: LIST("repository names") },
        ["title"],
      ),
      async invoke(p, a) {
        const wi = await d.items.createWorkItem(p, {
          title: str(a, "title")!,
          description: str(a, "description", false),
          context: str(a, "context", false),
          workflowRef: str(a, "workflow", false),
          repositoryRefs: strs(a, "repositories"),
        });
        return { name: wi.metadata.name, workflow: wi.spec.workflowRef?.name, repositories: (wi.spec.repositoryRefs ?? []).map((r) => r.name) };
      },
    }),
    tool({
      name: "set_work_item_context",
      humanOnly: true,
      description: "Set (replace) the additional context of a work item. Agents use it from their next run; use restart_work_item to redo finished steps.",
      inputSchema: obj({ name: S("work item name"), context: S("Markdown; empty removes it") }, ["name", "context"]),
      annotations: { idempotentHint: true },
      async invoke(p, a) {
        const wi = await d.items.updateWorkItemContext(p, str(a, "name")!, typeof a.context === "string" ? a.context : "");
        return { name: wi.metadata.name, context: wi.spec.context ?? null };
      },
    }),
    tool({
      name: "restart_work_item",
      humanOnly: true,
      description: "Re-run a work item's workflow from the first stage, or from the given stage, in a new round. Earlier output stays as history.",
      inputSchema: obj({ name: S("work item name"), stage: S("stage to restart from (optional)") }, ["name"]),
      annotations: { destructiveHint: true },
      async invoke(p, a) {
        const wi = await d.items.restartWorkItem(p, str(a, "name")!, str(a, "stage", false));
        return { name: wi.metadata.name, restart: wi.spec.restart };
      },
    }),
    tool({
      name: "answer_clarification",
      humanOnly: true,
      description:
        "Answer the open questions of a Blocked work item, one answer per question in order. Use \"(no answer)\" for a question you can't answer. The item resumes.",
      inputSchema: obj({ name: S("work item name"), answers: LIST("one answer per open question, in order") }, ["name", "answers"]),
      async invoke(p, a) {
        const name = str(a, "name")!;
        const x = await d.items.getWorkItem(p, name);
        if (!x) throw new Error(`work item ${name} not found`);
        const st = x.workItem.status;
        if (st?.phase !== "Blocked" || st.blockedBy?.kind !== "Clarification") throw new Error(`work item ${name} has no open questions (phase ${st?.phase ?? "New"})`);
        const c = await d.answers.answerClarification(p, st.blockedBy.name, strs(a, "answers") ?? []);
        return { clarification: c.metadata.name, answered: c.spec.answers?.length ?? 0 };
      },
    }),
    tool({
      name: "list_sources",
      description: "List the sources (manual, GitHub, Jira, …) work items come from.",
      inputSchema: obj({}),
      annotations: { readOnlyHint: true },
      async invoke(p) {
        return (await d.sources.listSources(p)).map((s) => ({ name: s.metadata.name, type: s.spec.type, writesBack: !!s.spec.sync?.bidirectional }));
      },
    }),
    tool({
      name: "sync_source",
      humanOnly: true,
      description: "Import new and updated items from a source (e.g. a Jira project) now.",
      inputSchema: obj({ name: S("source name") }, ["name"]),
      annotations: { idempotentHint: true },
      async invoke(p, a) {
        return d.sources.syncSource(p, str(a, "name")!);
      },
    }),
    tool({
      name: "search_knowledge",
      description: "Search the knowledge base: human-approved knowledge and maintained docs. Optional scope by repositories and workflow.",
      inputSchema: obj({ query: S("keywords"), repositories: LIST("only knowledge for these repositories"), workflow: S("only knowledge for this workflow") }, ["query"]),
      annotations: { readOnlyHint: true },
      async invoke(_p: Principal, a) {
        return d.search.searchKnowledge({ terms: str(a, "query")!.split(/\s+/), repositories: strs(a, "repositories"), workflow: str(a, "workflow", false), limit: 8 });
      },
    }),
    tool({
      name: "propose_knowledge",
      description: "Propose a knowledge base entry. It is NOT used by agents until a human approves it in the factory UI.",
      inputSchema: obj(
        { title: S("what someone would search for"), content: S("Markdown"), tags: LIST("1-5 tags"), repositories: LIST("scope: repositories"), workflows: LIST("scope: workflows") },
        ["title", "content"],
      ),
      async invoke(p, a) {
        const e = await d.knowledge.proposeKnowledge(p, {
          title: str(a, "title")!,
          content: str(a, "content")!,
          tags: strs(a, "tags"),
          repositories: strs(a, "repositories"),
          workflows: strs(a, "workflows"),
        });
        return { name: e.metadata.name, phase: "Proposed", note: "Approve it in the factory UI (Knowledge)." };
      },
    }),
  ];
}
