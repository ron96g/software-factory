import { createHash } from "node:crypto";
import type { ExecutionContext, Prompt, PromptBuilder } from "../ports/index.ts";

const proposesKnowledge = (ctx: ExecutionContext) => ctx.skills.some((s) => s.metadata.name === "knowledge-base");

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
  "questions": ["…"]${proposesKnowledge(ctx) ? `,  // only if you cannot proceed responsibly without a human answer; otherwise []
  "knowledge": [{ "title": "…", "content": "<markdown>", "tags": ["…"] }]   // optional, see the knowledge-base skill` : "   // only if you cannot proceed responsibly without a human answer; otherwise []"}
}
Rules: artifacts must contain exactly the listed types${outputs.length ? "" : " (none for this step)"}.
All diagrams in artifacts must be Mermaid code blocks. Cite code as repo:path:line. Never invent facts about the code.`;
};

const TOOLS_CONTRACT = (ctx: ExecutionContext) => {
  const outputs = ctx.run.spec.outputs.map((o) => o.name);
  return `## Working mode
You work on the work item's repository workspace (a pinned copy of the code) through the tools listed to you.
Ground your work in the actual code: search and read the relevant files before drawing conclusions, and cite code as
repo:path:line. If you have write/run tools, work in small steps and verify changes by running the relevant tests.
When you are done, call the \`finish\` tool exactly once with:
- summary: what you changed and why
- artifacts: [${outputs.map((o) => `{ "type": "${o}", "content": "<markdown>" }`).join(", ")}]${outputs.includes("source-code") ? " (the diff is attached automatically)" : ""}
- outcome: ${ctx.run.spec.outcomes?.length ? ctx.run.spec.outcomes.join(" | ") : "omit"}
- questions: only if you cannot proceed responsibly without a human answer.${proposesKnowledge(ctx) ? "\n- knowledge: optional reusable knowledge to propose (see the knowledge-base skill); humans approve it first." : ""}
All diagrams must be Mermaid. Never print secrets.`;
};

/** Pure function: Agent body + skills → system; work item, inputs, answers, sections → user. */
export class DefaultPromptBuilder implements PromptBuilder {
  build(ctx: ExecutionContext, mode: "json" | "tools" = "json"): Prompt {
    const system = [
      ctx.agent.body,
      ...ctx.skills.map((s) => `## Skill: ${s.metadata.name}\n${s.body}`),
      mode === "tools" ? TOOLS_CONTRACT(ctx) : OUTPUT_CONTRACT(ctx),
    ].join("\n\n");

    const wi = ctx.workItem;
    const parts = [
      `# Work item ${wi.metadata.name}: ${wi.spec.title}`,
      wi.spec.description ?? "(no description)",
      ...(wi.spec.context?.trim()
        ? [`## Additional context from the team\nProvided by humans working on this item. Use it; don't ask for what it already answers.\n\n${wi.spec.context.trim()}`]
        : []),
      `Source: ${wi.spec.sourceRef.name}${wi.spec.externalRef ? ` (${wi.spec.externalRef.id})` : ""}`,
      `Stage: ${ctx.run.spec.stage} · step: ${ctx.run.spec.step}`,
    ];
    if (wi.status?.classification) parts.push(`Current classification: ${JSON.stringify(wi.status.classification)}`);
    for (const a of ctx.inputs) parts.push(`## Input artifact: ${a.spec.artifactTypeRef.name}\n${a.spec.content}`);
    if (ctx.clarifications.some((c) => c.spec.answers?.some((a) => a === "(no answer)"))) {
      parts.push(
        "Note: answers marked \"(no answer)\" mean the human doesn't know. Proceed with reasonable assumptions, state them " +
          "explicitly (e.g. under an \"Assumptions\" heading), and do not ask the same question again.",
      );
    }
    for (const c of ctx.clarifications) {
      parts.push(
        `## Human clarification (${c.spec.stage})\n` +
          c.spec.questions.map((q, i) => `Q: ${q}\nA: ${c.spec.answers?.[i] ?? c.spec.answers?.join(" ") ?? ""}`).join("\n"),
      );
    }
    for (const a of ctx.approvals ?? []) {
      // Human gate decisions (e.g. "use your recommended defaults", or why something was rejected) steer later agents.
      if (!a.spec.comment?.trim() && a.spec.decision === "approve") continue;
      parts.push(
        `## Human gate decision (${a.spec.stage}): ${a.spec.decision?.toUpperCase()}${a.spec.overridden ? " (override despite failing evidence)" : ""}\n` +
          `${a.spec.comment?.trim() || "(no comment)"}\n` +
          (a.spec.decision === "reject" ? "Address this feedback first." : "Follow these instructions for any decisions still open."),
      );
    }
    for (const s of ctx.sections) parts.push(`## ${s.title} (from ${s.source})\n${s.content}`);
    return { system, user: parts.join("\n\n") };
  }
}

export const promptHash = (p: Prompt) => createHash("sha256").update(p.system + "\n---\n" + p.user).digest("hex").slice(0, 16);
