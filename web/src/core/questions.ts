import { createHash } from "node:crypto";

/** A question an agent asks: free-form string (legacy, non-blocking) or structured. */
export interface StructuredQuestion { id?: string; text: string; blocker?: boolean; options?: string[] }
export type AgentQuestion = string | StructuredQuestion;
export interface NormalizedQuestion { id: string; text: string; blocker: boolean; options: string[] }

export const DEFAULT_BLOCKER_OPTIONS = ["Yes", "No", "Other (explain in details)"];

export function questionId(text: string): string {
  return "q-" + createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 12);
}

/** Strings become non-blockers with a stable derived ID; blockers get default options when none are supplied. */
export function normalizeQuestions(qs: AgentQuestion[] | undefined): NormalizedQuestion[] {
  return (qs ?? []).map((q) => {
    const s: StructuredQuestion = typeof q === "string" ? { text: q } : q;
    const blocker = typeof q !== "string" && q.blocker === true;
    const options = s.options?.length ? s.options : blocker ? DEFAULT_BLOCKER_OPTIONS : [];
    return { id: s.id?.trim() || questionId(s.text), text: s.text, blocker, options };
  });
}
