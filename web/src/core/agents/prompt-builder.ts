import { createHash } from "node:crypto";
import type { ExecutionContext, Prompt, PromptBuilder } from "../ports/index.ts";

const OUTPUT_CONTRACT = (ctx: ExecutionContext) => {
  const outputs = ctx.run.spec.outputs.map((o) => o.name);
  const outcomes = ctx.run.spec.outcomes;
  return `## Output contract
Respond with ONE JSON object and nothing else:
{
  "summary": "one or two sentences describing what you did and why",
  "artifacts": [${outputs.map((o) => `{ "type": "${o}", "content": "<markdown>" }`).join(", ")}],
  "classification": { "type": "feature|bug|incident|chore|question", "priority": "P0-P3", "labels": [], "confidence": 0.0 } | null,
  "outcome": ${outcomes?.length ? outcomes.map((o) => `"${o}"`).join(" | ") : "null"},
  "questions": ["…"]   // only if you cannot proceed responsibly without a human answer; otherwise []
}
Rules: artifacts must contain exactly the listed types${outputs.length ? "" : " (none for this step)"}.
All diagrams in artifacts must be Mermaid code blocks. Cite code as repo:path:line. Never invent facts about the code.`;
};

/** Pure function: Agent body + skills → system; work item, inputs, answers, sections → user. */
export class DefaultPromptBuilder implements PromptBuilder {
  build(ctx: ExecutionContext): Prompt {
    const system = [
      ctx.agent.body,
      ...ctx.skills.map((s) => `## Skill: ${s.metadata.name}\n${s.body}`),
      OUTPUT_CONTRACT(ctx),
    ].join("\n\n");

    const wi = ctx.workItem;
    const parts = [
      `# Work item ${wi.metadata.name}: ${wi.spec.title}`,
      wi.spec.description ?? "(no description)",
      `Source: ${wi.spec.sourceRef.name}${wi.spec.externalRef ? ` (${wi.spec.externalRef.id})` : ""}`,
      `Stage: ${ctx.run.spec.stage} · step: ${ctx.run.spec.step}`,
    ];
    if (wi.status?.classification) parts.push(`Current classification: ${JSON.stringify(wi.status.classification)}`);
    for (const a of ctx.inputs) parts.push(`## Input artifact: ${a.spec.artifactTypeRef.name}\n${a.spec.content}`);
    for (const c of ctx.clarifications) {
      parts.push(
        `## Human clarification (${c.spec.stage})\n` +
          c.spec.questions.map((q, i) => `Q: ${q}\nA: ${c.spec.answers?.[i] ?? c.spec.answers?.join(" ") ?? ""}`).join("\n"),
      );
    }
    for (const s of ctx.sections) parts.push(`## ${s.title} (from ${s.source})\n${s.content}`);
    return { system, user: parts.join("\n\n") };
  }
}

export const promptHash = (p: Prompt) => createHash("sha256").update(p.system + "\n---\n" + p.user).digest("hex").slice(0, 16);
