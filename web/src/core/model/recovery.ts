/** ADR-0059 recovery policy. All budgets include attempts consumed before a restart. */
export interface RecoveryPolicy {
  version: string;
  maxDiagnosisAttempts?: number;
  maxTotalAttempts: number;
  humanNeedReserve: 0 | 1;
  maxOperatorAllowance: number;
  diagnosticChecks: string[];
}

export interface RecoveryTrigger {
  kind: "AgentRun" | "CheckRun";
  name: string;
  uid: string;
}

export interface RecoveryAssignment {
  episode: string;
  attempt: number;
  mode: "diagnosis" | "repair" | "execution-recovery";
  planFingerprint: string;
  unit: string;
  policyVersion: string;
  trigger: RecoveryTrigger;
}

export interface RecoveryReport {
  schemaVersion: "1";
  episode: string;
  trigger: RecoveryTrigger & { resourceVersion: string };
  failureSignature: string;
  facts: string[];
  hypotheses: string[];
  actions: { action: string; result: string }[];
  obligations: string[];
  evidence: { kind: "AgentRun" | "CheckRun" | "Artifact"; name: string; resourceVersion: string }[];
  codeEvidence?: { repository: string; path: string; startLine: number; endLine: number; snapshot: string }[];
  recommendation: "diagnose" | "repair" | "execution-recovery" | "human-need" | "stop";
  humanNeed?: { kind: "sandbox-runtime"; runtime: string; need: string; options: string[]; recommendation: string };
}

export interface RecoveryEpisode {
  id: string;
  workItemUid: string;
  planFingerprint: string;
  unit: string;
  policyVersion: string;
  stage: string;
  maxTotalAttempts: number;
  operatorAllowance: number;
  operatorAllocations?: { diagnosis: number; repair: number; execution: number };
  trigger: RecoveryTrigger;
  diagnosticAttempts: number;
  codeAttempts: number;
  executionAttempts: number;
  latestReport?: { name: string; resourceVersion: string };
  failureSignature?: string;
  repairSignature?: string;
  repairEvidence?: string[];
  nextAttemptMode?: "repair" | "execution-recovery";
  disposition: "diagnosing" | "repairing" | "waiting" | "blocked" | "failed" | "resolved";
  retryAt?: string;
  runtimeWaits?: number;
  humanNeedConsumed?: { need: string; answerVersion: string };
  humanNeed?: NonNullable<RecoveryReport["humanNeed"]> & { clarification: string };
  consumedAllowances?: string[];
}

export interface RecoveryAllowance {
  requestId: string;
  requestedBy: string;
  requestReason: string;
  workItemUid: string;
  episode: string;
  report: { name: string; resourceVersion: string };
  planFingerprint: string;
  policyVersion: string;
  count: number;
  target: "diagnosis" | "repair" | "execution-recovery";
}
