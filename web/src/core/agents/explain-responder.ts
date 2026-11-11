import type { AgentRun, Conversation } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  ChatMessage,
  ConversationResponder,
  ModelResolver,
  ResourceReader,
  StatusWriter,
  TranscriptAuthor,
  TranscriptMessage,
  TranscriptReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";

const EXPLAIN_RULES = `You are answering follow-up questions about a run you performed earlier (ADR-0012, explain mode).
- Ground every statement in the recorded transcript and provenance below. Quote them where possible.
- If the transcript does not show something, say so. Do not speculate about hidden reasoning.
- You cannot change anything: no artifacts, decisions or work item state. If the human disagrees, point them to
  the normal actions (answer a clarification, reject an approval, or create a new work item).`;

/** Explain-mode responder: side-effect free apart from appending to the conversation transcript. */
export class ExplainResponder implements ConversationResponder {
  private readonly d: {
    reader: ResourceReader;
    status: StatusWriter;
    transcripts: TranscriptReader;
    recorders: TranscriptRecorderFactory;
    models: ModelResolver;
  };
  constructor(d: ExplainResponder["d"]) {
    this.d = d;
  }

  async respond(conv: Conversation, humanMessage: string, author: TranscriptAuthor): Promise<TranscriptMessage> {
    const ns = nsOf(conv);
    const run = await this.d.reader.get<AgentRun>("AgentRun", ns, conv.spec.agentRunRef.name);
    if (!run?.status?.transcriptRef) throw new Error("the original run has no transcript");
    const recorder = await this.d.recorders.forConversation(conv);
    if (!conv.status?.transcriptRef) {
      conv = await this.d.status.updateStatus({ ...conv, status: { transcriptRef: recorder.ref, messageCount: 0 } });
    }
    const original = await this.d.transcripts.read(run.status.transcriptRef);
    const history = await this.d.transcripts.read(recorder.ref);
    await recorder.record({ role: "user", author, content: humanMessage });

    const agentAuthor = { type: "agent" as const, id: run.spec.agentRef.name };
    const model = await this.d.models.resolve({ namespace: ns, tier: "reasoning" });
    let answer: string;
    if (model) {
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${EXPLAIN_RULES}\n\n## Provenance\n${JSON.stringify(run.status.provenance ?? {}, null, 2)}\n\n## Result\n${JSON.stringify(
            run.status.result ?? {},
            null,
            2,
          )}\n\n## Original transcript\n${renderTranscript(original)}`,
        },
        ...history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: humanMessage },
      ];
      answer = await model.client.complete({ messages, tier: model.tier });
    } else {
      answer = deterministicExplanation(run, original);
    }
    await recorder.record({ role: "assistant", author: agentAuthor, content: answer, meta: model ? { model: model.model } : { mode: "deterministic" } });
    const fresh = (await this.d.reader.get<Conversation>("Conversation", ns, conv.metadata.name))!;
    await this.d.status.updateStatus({
      ...fresh,
      status: { ...fresh.status, messageCount: history.length + 2, lastMessageAt: new Date().toISOString() },
    });
    const all = await this.d.transcripts.read(recorder.ref);
    return all[all.length - 1];
  }
}

function renderTranscript(msgs: TranscriptMessage[]): string {
  return msgs.map((m) => `[${m.seq}] ${m.role} (${m.author.type}:${m.author.id})${m.meta?.tool ? ` tool=${m.meta.tool}` : ""}\n${m.content.slice(0, 6000)}`).join("\n\n");
}

function deterministicExplanation(run: AgentRun, msgs: TranscriptMessage[]): string {
  const p = run.status?.provenance;
  const r = run.status?.result;
  const notes = msgs.filter((m) => m.role === "note").map((m) => `- ${m.content}`);
  const tools = msgs.filter((m) => m.role === "tool-call").map((m) => `- ${m.meta?.tool}: ${m.content}`);
  return [
    "No LLM is configured, so here is what the recorded transcript shows:",
    `**Executor:** ${p?.executor ?? "unknown"}${p?.model ? ` (${p.model.provider}/${p.model.name})` : ""}`,
    r?.summary ? `**Summary:** ${r.summary}` : "",
    r?.outcome ? `**Outcome:** ${r.outcome}` : "",
    r?.questions?.length ? `**Questions asked:**\n${r.questions.map((q) => `- ${q}`).join("\n")}` : "",
    notes.length ? `**Notes:**\n${notes.join("\n")}` : "",
    tools.length ? `**Tool calls:**\n${tools.join("\n")}` : "",
    `**Inputs used:** ${Object.keys(p?.inputs ?? {}).join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
