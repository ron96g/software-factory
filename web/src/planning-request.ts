import type { PlanningRevisionInput, PlanningSections } from "./core/ports/planning.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Unknown ${label} field`);
}

export function parsePlanningRevision(value: unknown): PlanningRevisionInput {
  if (!record(value)) throw new Error("Planning request must be an object");
  exact(value, ["revision", "requestId", "action", "workflow", "context", "draft", "feedback", "answers", "withdraw"], "planning request");
  const { revision, requestId, action } = value;
  if (typeof revision !== "string" || !revision.trim() || revision.length > 100) throw new Error("revision is required (at most 100 characters)");
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
    throw new Error("requestId must contain 1–100 letters, digits, underscores or hyphens");
  }
  if (action !== "revise" && action !== "decisions" && action !== "reopen" && action !== "reject" && action !== "defer" && action !== "migrate") {
    throw new Error("Invalid planning action");
  }
  const input: PlanningRevisionInput = { revision, requestId, action };
  if (action === "migrate") {
    if (typeof value.workflow !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.workflow)) {
      throw new Error("Migration workflow must be a valid workflow name");
    }
    if (Object.keys(value).some((key) => !["revision", "requestId", "action", "workflow"].includes(key))) {
      throw new Error("Workflow migration cannot include planning edits");
    }
    input.workflow = value.workflow;
  } else if ("workflow" in value) {
    throw new Error("workflow is only valid for a migration");
  }
  for (const key of ["context", "feedback"] as const) {
    if (key in value) {
      if (typeof value[key] !== "string" || value[key].length > 20_000) throw new Error(`${key} must be text of at most 20000 characters`);
      input[key] = value[key];
    }
  }
  if ("draft" in value) {
    const draft = value.draft;
    const legacy = ["outcome", "scope", "approach", "delivery", "acceptance"] as const;
    if (!record(draft)) throw new Error("draft must contain all six text sections or only risks");
    exact(draft, [...legacy, "risks"], "draft");
    const present = legacy.filter((key) => key in draft);
    if (present.length !== 0 && present.length !== legacy.length) throw new Error("draft must contain all six text sections or only risks");
    const sections: PlanningSections = { risks: "" };
    for (const key of ["risks", ...present] as const) {
      const text = draft[key];
      if (typeof text !== "string" || !text.trim() || text.length > 12_000) throw new Error("Each draft section must contain 1–12000 characters");
      sections[key] = text;
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
  if ("withdraw" in value) {
    if (!Array.isArray(value.withdraw) || value.withdraw.length > 100 ||
        value.withdraw.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) ||
        new Set(value.withdraw).size !== value.withdraw.length) {
      throw new Error("withdraw must be a list of unique decision IDs (at most 100)");
    }
    input.withdraw = value.withdraw;
  }
  return input;
}
