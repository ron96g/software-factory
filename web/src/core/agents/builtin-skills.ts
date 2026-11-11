import type { Classification } from "../model/kinds.ts";
import type { AgentExecutor, AgentResult, ExecutionContext, SkillHandler } from "../ports/index.ts";

const TYPE_RULES: [string, RegExp][] = [
  ["incident", /\b(outage|down|incident|sev[0-9]|p0|production is)\b/i],
  ["bug", /\b(bug|error|crash|fail(s|ed|ing)?|broken|exception|stack ?trace|regression|wrong)\b/i],
  ["chore", /\b(refactor|upgrade|bump|cleanup|clean up|chore|dependency|deps)\b/i],
  ["question", /\?\s*$|\b(how do|why does|what is)\b/i],
];

/** Fast keyword heuristic used when no LLM is configured. */
export function heuristicClassification(text: string): Classification {
  const type = TYPE_RULES.find(([, re]) => re.test(text))?.[0] ?? "feature";
  const priority = type === "incident" ? "P0" : /\b(urgent|asap|critical|blocker)\b/i.test(text) ? "P1" : type === "bug" ? "P2" : "P3";
  const labels = [...new Set((text.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? []).filter((w) => !STOP.has(w)))].slice(0, 4);
  return { type, priority, labels, confidence: 0.4 };
}

/** Skill handler: `work-item-classification` without an LLM. */
export const classificationHandler: SkillHandler = {
  skill: "work-item-classification",
  async handle(ctx) {
    const c = heuristicClassification(`${ctx.workItem.spec.title}\n${ctx.workItem.spec.description ?? ""}`);
    return { summary: `Heuristically classified as ${c.type} / ${c.priority}.`, classification: c };
  },
};

/** Skill handler: `codebase-research` from the code-search context section (no LLM needed). */
export const codebaseResearchHandler: SkillHandler = {
  skill: "codebase-research",
  async handle(ctx) {
    const hits = ctx.sections.filter((s) => s.source === "code-search");
    const docs = ctx.sections.filter((s) => s.source === "repository-docs");
    const repos = ctx.repositories.map((r) => r.metadata.name);
    const body = [
      `# Research notes: ${ctx.workItem.spec.title}`,
      `## Summary`,
      hits.length
        ? `Keyword search over ${repos.join(", ")} found the locations below. They are candidates and need human or LLM confirmation.`
        : `No matching code was found in ${repos.join(", ") || "any linked repository"}.`,
      `## Affected components (candidates)`,
      ...hits.map((h) => h.content),
      `## Impact estimate`,
      hits.length > 8 ? "L (many matches across modules)" : hits.length > 2 ? "M" : "S (or unknown)",
      `## Unknowns / open questions`,
      `- The keyword search cannot judge relevance. Verify that the candidate locations are actually affected.`,
      ...(docs.length ? [`## Repository docs consulted`, ...docs.map((d) => `- ${d.title}`)] : []),
    ].join("\n\n");
    return { summary: `Researched ${repos.length} repositories (${hits.length} sections with hits).`, artifacts: [{ type: "research-notes", content: body }] };
  },
};

/**
 * Last link of the chain: placeholder artifacts so the full loop is visible (ADR-0010).
 * Triage asks for details when the description is thin and nobody has answered yet,
 * which demonstrates block → answer → resume without an LLM.
 */
export class SimulatedExecutor implements AgentExecutor {
  readonly name = "simulated";
  canExecute(): boolean {
    return true;
  }
  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const author = { type: "agent" as const, id: ctx.agent.metadata.name };
    await ctx.transcript.record({
      role: "note",
      author: { type: "system", id: "simulated-executor" },
      content: simulationReason(ctx),
    });
    const result: AgentResult = {
      summary: `Simulated ${ctx.agent.spec.role} output for ${ctx.run.spec.step}.`,
      artifacts: ctx.run.spec.outputs.map((o) => ({
        type: o.name,
        content: `# ${o.name} (simulated)\n\nPlaceholder produced by **${ctx.agent.metadata.name}** in stage \`${ctx.run.spec.stage}\`.\n\nInputs: ${ctx.inputs.map((i) => i.spec.artifactTypeRef.name).join(", ") || "none"}.`,
      })),
    };
    const outcomes = ctx.run.spec.outcomes;
    if (outcomes?.length) {
      const thin = (ctx.workItem.spec.description ?? "").trim().length < 40;
      if (thin && !ctx.clarifications.length && outcomes.includes("needs-info")) {
        result.outcome = "needs-info";
        result.questions = [
          "What is the expected behaviour or outcome?",
          "Who is affected, and how urgent is it?",
        ];
        result.summary = "The description is too thin to triage. Asking the reporter for details.";
      } else {
        result.outcome = outcomes.includes("accept") ? "accept" : outcomes[0];
      }
    }
    await ctx.transcript.record({ role: "assistant", author, content: JSON.stringify(result, null, 2) });
    return result;
  }
}

function simulationReason(ctx: ExecutionContext): string {
  if (ctx.sandbox && !ctx.sandbox.available) {
    return `Simulated: this agent needs a sandbox, but ${ctx.sandbox.message ?? "none is available"}. Configure FACTORY_SANDBOX_RUNTIME (ADR-0019).`;
  }
  if (ctx.sandbox?.available) return `Simulated: sandbox "${ctx.sandbox.runtime}" is available, but the tool-call loop isn't implemented yet (v0.3 S3).`;
  if (!ctx.model) return "Simulated: no ModelProvider with a resolvable secret is configured (ADR-0014).";
  return `Simulated: agent tools [${(ctx.agent.spec.tools ?? []).join(", ")}] are not available (ADR-0019).`;
}

const STOP = new Set([
  "about", "after", "again", "should", "would", "could", "there", "their", "which", "where", "these", "those",
  "please", "being", "other", "every", "while", "because", "using", "users", "thing", "things", "when", "that",
]);
