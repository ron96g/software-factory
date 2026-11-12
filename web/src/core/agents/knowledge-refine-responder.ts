import type { Agent, Conversation, KnowledgeEntry } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { resolveRef } from "../refs/refs.ts";
import { DRAFT_FENCE } from "../model/knowledge-draft.ts";
import type {
  ChatMessage,
  ConversationResponder,
  ModelResolver,
  Redactor,
  ResourceReader,
  TranscriptAuthor,
  TranscriptMessage,
  TranscriptReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";

const RULES = `You are refining one knowledge base entry together with a human reviewer (ADR-0030).
- You proposed this entry earlier (or you are the agent role responsible for it). Discuss it honestly: say what you
  are unsure about, and correct mistakes the human points out.
- When you suggest a change, include the COMPLETE revised entry once, in a block fenced with FOUR backticks:
  \`\`\`\`${DRAFT_FENCE}
  # <title>
  <markdown content>
  \`\`\`\`
- You cannot save, approve or publish anything. The human applies a draft and decides on approval.
- Keep entries short, factual, reusable for other work, and free of secrets and personal data. Cite code as repo:path:line.`;

/** Side-effect free apart from the conversation transcript: the human applies drafts via a normal spec edit. */
export class KnowledgeRefineResponder implements ConversationResponder {
  private readonly d: { reader: ResourceReader; transcripts: TranscriptReader; recorders: TranscriptRecorderFactory; models: ModelResolver; redactor: Redactor };
  constructor(d: KnowledgeRefineResponder["d"]) {
    this.d = d;
  }

  async respond(conv: Conversation, humanMessage: string, author: TranscriptAuthor): Promise<TranscriptMessage> {
    if (!conv.status?.transcriptRef) throw new Error("conversation is not ready yet (transcript not opened)");
    if (!conv.spec.knowledgeRef) throw new Error("refine-knowledge conversations need a knowledge entry");
    const ns = nsOf(conv);
    const entry = await this.d.reader.get<KnowledgeEntry>("KnowledgeEntry", ns, conv.spec.knowledgeRef.name);
    if (!entry) throw new Error(`knowledge entry ${conv.spec.knowledgeRef.name} not found`);
    const agentName = conv.spec.agentRef?.name ?? entry.spec.provenance?.agent;
    const agent = agentName ? await resolveRef<Agent>(this.d.reader, "Agent", { name: agentName }, ns) : null;

    const recorder = await this.d.recorders.forConversation(conv);
    const history = await this.d.transcripts.read(recorder.ref);
    await recorder.record({ role: "user", author, content: humanMessage });

    const model = await this.d.models.resolve({ namespace: ns, tier: "reasoning", agent: agentName });
    let answer: string;
    if (model) {
      const system = [agent?.body ?? "", RULES, this.d.redactor.redact(describe(entry))].filter(Boolean).join("\n\n");
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: humanMessage },
      ];
      answer = await model.client.complete({ messages, tier: model.tier });
    } else {
      answer = "No LLM is configured, so the agent can't discuss this entry. Edit the title and content directly, then approve or reject it.";
    }
    await recorder.record({ role: "assistant", author: { type: "agent", id: agentName ?? "factory" }, content: answer, meta: model ? { model: model.model } : { mode: "deterministic" } });
    const all = await this.d.transcripts.read(recorder.ref);
    return all[all.length - 1];
  }
}

function describe(e: KnowledgeEntry): string {
  const p = e.spec.provenance;
  return [
    `# Knowledge entry ${e.metadata.name} (${e.status?.phase ?? "Proposed"})`,
    `Title: ${e.spec.title}`,
    `Tags: ${(e.spec.tags ?? []).join(", ") || "–"}`,
    `Scope: repositories ${(e.spec.scope?.repositories ?? []).join(", ") || "any"}; workflows ${(e.spec.scope?.workflows ?? []).join(", ") || "any"}`,
    p ? `Proposed by ${p.agent ?? "?"} in run ${p.agentRun ?? "?"} (work item ${p.workItem ?? "?"})` : "",
    e.spec.review?.comment ? `Reviewer comment (${e.spec.review.decision}): ${e.spec.review.comment}` : "",
    "## Current content",
    e.spec.content,
  ]
    .filter(Boolean)
    .join("\n");
}
