import type { AgentRun, Artifact, Conversation } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type {
  ChatMessage,
  ConversationResponder,
  ModelResolver,
  Redactor,
  WorkItemRecordReader,
  TranscriptAuthor,
  TranscriptMessage,
  TranscriptReader,
  TranscriptRecorderFactory,
} from "../ports/index.ts";
import { workItemDigest } from "./work-item-digest.ts";

const RULES = `You answer questions about one work item of the Software Factory, using ONLY the record below
(agent runs with their results, artifacts, human input, and events). This is explain mode (ADR-0012):
- Attribute work to the agent and run that did it, e.g. "product-owner (spec/write-spec, round 4) wrote …".
- Quote or summarise artifacts precisely; say when something is not in the record. Don't speculate.
- You cannot change anything. For changes, point to the normal actions (answer, approve/reject, re-run, new work item).
- Be concise; use Markdown (lists, tables) where it helps.`;

const roundOf = (r: AgentRun) => /-r(\d+)(?:-replay-\d+)?$/.exec(r.metadata.name)?.[1] ?? "?";

/**
 * X4: explains the whole work item. The context is a digest (bounded size) of all runs, artifacts, human input and
 * key events, so one question can span every agent. Side-effect free apart from the conversation transcript.
 */
export class ItemExplainResponder implements ConversationResponder {
  private readonly d: { records: WorkItemRecordReader; transcripts: TranscriptReader; recorders: TranscriptRecorderFactory; models: ModelResolver; redactor: Redactor };
  constructor(d: ItemExplainResponder["d"]) {
    this.d = d;
  }

  async respond(conv: Conversation, humanMessage: string, author: TranscriptAuthor): Promise<TranscriptMessage> {
    if (!conv.status?.transcriptRef) throw new Error("conversation is not ready yet (transcript not opened)");
    const ns = nsOf(conv);
    if (!conv.spec.workItemRef) throw new Error("explain-item conversations need a work item");
    const name = conv.spec.workItemRef.name;
    const record = await this.d.records.read(ns, name);
    const { runs, artifacts } = record;

    const recorder = await this.d.recorders.forConversation(conv);
    const history = await this.d.transcripts.read(recorder.ref);
    await recorder.record({ role: "user", author, content: humanMessage });

    const model = await this.d.models.resolve({ namespace: ns, tier: "reasoning" });
    let answer: string;
    if (model) {
      const messages: ChatMessage[] = [
        // Defence in depth (ADR-0015): human answers/comments in the digest are not redacted at write time.
        { role: "system", content: `${RULES}\n\n${this.d.redactor.redact(workItemDigest(record))}` },
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
