import type { AgentRun, Approval, Artifact, Clarification, Conversation, FactoryEvent, WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  ChatMessage,
  ConversationResponder,
  ModelResolver,
  ResourceReader,
  TranscriptAuthor,
  TranscriptMessage,
  TranscriptReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";

const RULES = `You answer questions about one work item of the Software Factory, using ONLY the record below
(agent runs with their results, artifacts, human input, and events). This is explain mode (ADR-0012):
- Attribute work to the agent and run that did it, e.g. "product-owner (spec/write-spec, round 4) wrote …".
- Quote or summarise artifacts precisely; say when something is not in the record. Don't speculate.
- You cannot change anything. For changes, point to the normal actions (answer, approve/reject, re-run, new work item).
- Be concise; use Markdown (lists, tables) where it helps.`;

const roundOf = (r: AgentRun) => /-r(\d+)(?:-replay-\d+)?$/.exec(r.metadata.name)?.[1] ?? "?";
const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)} …[truncated]` : s);

/**
 * X4: explains the whole work item. The context is a digest (bounded size) of all runs, artifacts, human input and
 * key events, so one question can span every agent. Side-effect free apart from the conversation transcript.
 */
export class ItemExplainResponder implements ConversationResponder {
  private readonly d: { reader: ResourceReader; transcripts: TranscriptReader; recorders: TranscriptRecorderFactory; models: ModelResolver };
  constructor(d: ItemExplainResponder["d"]) {
    this.d = d;
  }

  async respond(conv: Conversation, humanMessage: string, author: TranscriptAuthor): Promise<TranscriptMessage> {
    if (!conv.status?.transcriptRef) throw new Error("conversation is not ready yet (transcript not opened)");
    const ns = nsOf(conv);
    const name = conv.spec.workItemRef.name;
    const owned = { kind: "WorkItem", name, namespace: ns };
    const [wi, runs, artifacts, clarifications, approvals, events] = await Promise.all([
      this.d.reader.get<WorkItem>("WorkItem", ns, name),
      this.d.reader.list<AgentRun>("AgentRun", { namespace: ns, ownedBy: owned }),
      this.d.reader.list<Artifact>("Artifact", { namespace: ns, ownedBy: owned }),
      this.d.reader.list<Clarification>("Clarification", { namespace: ns, ownedBy: owned }),
      this.d.reader.list<Approval>("Approval", { namespace: ns, ownedBy: owned }),
      this.d.reader.list<FactoryEvent>("Event", { namespace: ns, labelSelector: { "factory.ai-dlc.io/workitem": name } }),
    ]);
    if (!wi) throw new Error(`work item ${name} not found`);

    const recorder = await this.d.recorders.forConversation(conv);
    const history = await this.d.transcripts.read(recorder.ref);
    await recorder.record({ role: "user", author, content: humanMessage });

    const model = await this.d.models.resolve({ namespace: ns, tier: "reasoning" });
    let answer: string;
    if (model) {
      const messages: ChatMessage[] = [
        { role: "system", content: `${RULES}\n\n${digest(wi, runs, artifacts, clarifications, approvals, events)}` },
        ...history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: humanMessage },
      ];
      answer = await model.client.complete({ messages, tier: model.tier });
    } else {
      answer = deterministic(humanMessage, runs, artifacts);
    }
    await recorder.record({ role: "assistant", author: { type: "agent", id: "factory" }, content: answer, meta: model ? { model: model.model } : { mode: "deterministic" } });
    const all = await this.d.transcripts.read(recorder.ref);
    return all[all.length - 1];
  }
}

/** Bounded, chronological record of the item (budget keeps prompts manageable for long items). */
export function digest(wi: WorkItem, runs: AgentRun[], artifacts: Artifact[], clar: Clarification[], appr: Approval[], events: FactoryEvent[]): string {
  const parts: string[] = [
    `# Work item ${wi.metadata.name}: ${wi.spec.title}`,
    clip(wi.spec.description, 2000),
    `Status: ${wi.status?.phase} · stage ${wi.status?.stage} · round ${wi.status?.round}`,
    "## Agent runs (chronological)",
    ...runs.map((r) => {
      const res = r.status?.result;
      const p = r.status?.provenance;
      return [
        `- **${r.spec.agentRef.name}** · ${r.spec.stage}/${r.spec.step} · round ${roundOf(r)}${r.spec.replayOf ? " · replay" : ""} · ${r.status?.phase} · ${p?.executor ?? ""}${p?.model ? ` (${p.model.name})` : ""} · run \`${r.metadata.name}\``,
        res?.summary ? `  - summary: ${clip(res.summary, 800)}` : "",
        res?.outcome ? `  - outcome: ${res.outcome}` : "",
        res?.questions?.length ? `  - asked: ${res.questions.join(" | ")}` : "",
        r.status?.message ? `  - message: ${clip(r.status.message, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
    "## Artifacts (latest content per run, truncated)",
    ...artifacts.map((a) => `### ${a.spec.artifactTypeRef.name} by ${a.spec.producedBy?.agentRef.name} (run \`${a.spec.producedBy?.agentRunRef.name}\`)\n${clip(a.spec.content, 6000)}`),
    "## Human input",
    ...clar.map((c) => `- clarification (${c.spec.stage}): ${c.spec.questions.join(" | ")} → ${c.spec.answers?.join(" | ") ?? "(open)"}`),
    ...appr.map((a) => `- approval (${a.spec.stage}): ${a.spec.decision ?? "pending"}${a.spec.comment ? ` — ${a.spec.comment}` : ""}`),
    "## Key events",
    ...events
      .filter((e) => e.spec.type === "Warning" || !["Started", "Succeeded", "Preparing"].includes(e.spec.reason))
      .slice(-40)
      .map((e) => `- ${e.metadata.creationTimestamp} ${e.spec.type === "Warning" ? "⚠ " : ""}${e.spec.reason}: ${clip(e.spec.message, 300)}`),
  ];
  const text = parts.join("\n");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[record truncated]` : text;
}

/** Without an LLM: list the runs (and artifacts) of agents mentioned in the question, else all. */
function deterministic(question: string, runs: AgentRun[], artifacts: Artifact[]): string {
  const q = question.toLowerCase().replace(/\bpo\b/g, "product-owner");
  const agents = [...new Set(runs.map((r) => r.spec.agentRef.name))];
  const hit = agents.filter((a) => q.includes(a) || q.includes(a.replace(/-/g, " ")));
  const selected = hit.length ? runs.filter((r) => hit.includes(r.spec.agentRef.name)) : runs;
  const lines = selected.map((r) => `- **${r.spec.agentRef.name}** · ${r.spec.stage}/${r.spec.step} · round ${roundOf(r)}: ${r.status?.result?.summary ?? r.status?.phase ?? ""}`);
  const arts = artifacts.filter((a) => !hit.length || hit.includes(a.spec.producedBy?.agentRef.name ?? "")).map((a) => `\`${a.spec.artifactTypeRef.name}\``);
  return [
    "No LLM is configured; here is what the record shows" + (hit.length ? ` for ${hit.join(", ")}:` : ":"),
    ...lines,
    arts.length ? `\nArtifacts: ${[...new Set(arts)].join(", ")}` : "",
  ].join("\n");
}
