import type { PlanningRevisionInput, PlanningSections } from "./core/ports/planning.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Unknown ${label} field`);
}

export function parsePlanningRevision(value: unknown): PlanningRevisionInput {
  if (!record(value)) throw new Error("Planning request must be an object");
  exact(value, ["revision", "requestId", "action", "context", "draft", "feedback", "answers"], "planning request");
  const { revision, requestId, action } = value;
  if (typeof revision !== "string" || !revision.trim() || revision.length > 100) throw new Error("revision is required (at most 100 characters)");
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
    throw new Error("requestId must contain 1–100 letters, digits, underscores or hyphens");
  }
  if (action !== "revise" && action !== "decisions" && action !== "reopen" && action !== "reject" && action !== "defer") {
    throw new Error("Invalid planning action");
  }
  const input: PlanningRevisionInput = { revision, requestId, action };
  for (const key of ["context", "feedback"] as const) {
    if (key in value) {
      if (typeof value[key] !== "string" || value[key].length > 20_000) throw new Error(`${key} must be text of at most 20000 characters`);
      input[key] = value[key];
    }
  }
  if ("draft" in value) {
    const draft = value.draft;
    if (!record(draft)) throw new Error("draft must contain all six text sections");
    exact(draft, ["outcome", "scope", "approach", "delivery", "acceptance", "risks"], "draft");
    const { outcome, scope, approach, delivery, acceptance, risks } = draft;
    if (typeof outcome !== "string" || typeof scope !== "string" || typeof approach !== "string"
      || typeof delivery !== "string" || typeof acceptance !== "string" || typeof risks !== "string") {
      throw new Error("draft must contain all six text sections");
    }
    const sections: PlanningSections = { outcome, scope, approach, delivery, acceptance, risks };
    if (Object.values(sections).some((text) => !text.trim() || text.length > 12_000)) {
      throw new Error("Each draft section must contain 1–12000 characters");
    }
    input.draft = sections;
  }
  if ("answers" in value) {
    if (!record(value.answers)) throw new Error("answers must be a record of text answers");
    const answers: Record<string, string> = {};
    for (const [key, answer] of Object.entries(value.answers)) {
      if (!key.trim() || typeof answer !== "string" || !answer.trim() || answer.length > 4000) {
        throw new Error("answers must have nonempty IDs and 1–4000 characters of text");
      }
      Object.defineProperty(answers, key, { value: answer, enumerable: true, configurable: true, writable: true });
    }
    input.answers = answers;
  }
  return input;
}
