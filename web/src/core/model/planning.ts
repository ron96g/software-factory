export interface PlanningSections {
  outcome: string;
  scope: string;
  approach: string;
  delivery: string;
  acceptance: string;
  risks: string;
}

export interface PlanningDecision {
  id: string;
  question: string;
  options: string[];
  recommendation?: string;
  rationale: string;
  required: boolean;
}

export interface PlanningDocument extends PlanningSections {
  decisions: PlanningDecision[];
}
