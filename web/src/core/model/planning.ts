/** Sections of the legacy `full` plan format only; a decision sheet must not repeat them (ADR-0051). */
export const LEGACY_PLAN_SECTIONS = ["outcome", "scope", "approach", "delivery", "acceptance"] as const;

/** `full`: six sections (ADR-0045). `decision-sheet`: risks plus decisions only (ADR-0051). */
export type PlanFormat = "full" | "decision-sheet";

export interface PlanningSections {
  outcome?: string;
  scope?: string;
  approach?: string;
  delivery?: string;
  acceptance?: string;
  risks: string;
}

export interface PlanningDecision {
  id: string;
  question: string;
  options: string[];
  recommendation?: string;
  rationale: string;
  required: boolean;
  /** IDs of upstream agent questions this decision answers (explicit link, independent of wording). */
  answersQuestionIds?: string[];
}

export interface PlanningDocument extends PlanningSections {
  decisions: PlanningDecision[];
}
