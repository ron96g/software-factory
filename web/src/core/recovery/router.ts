import { createHash } from "node:crypto";
import { LABEL_SUPERSEDED, type AgentRun, type CheckRun, type WorkItem } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { RecoveryReport } from "../model/recovery.ts";
import { isStoreError, type ArtifactSchemaReader, type JsonSchemaValidator, type ProposedArtifactCheck, type RecoveryRoute,
  type RecoveryRouter, type ResourceReader, type VerificationContracts, type CandidateSnapshots, type WorkspaceReaderFactory } from "../ports/index.ts";

type Evidence = AgentRun | CheckRun | import("../model/kinds.ts").Artifact;
const owned = (item: WorkItem, value: Evidence) =>
  !!item.metadata.uid && value.metadata.namespace === nsOf(item) && value.metadata.ownerReferences?.some(
    (owner) => owner.kind === "WorkItem" && owner.name === item.metadata.name && owner.uid === item.metadata.uid,
  ) && !value.metadata.labels?.[LABEL_SUPERSEDED] && !value.metadata.labels?.["factory.ai-dlc.io/replay"];

/** Signature uses persisted observations, not the model's description or a fresh caller identity. */
export function recoveryFailureSignature(trigger: AgentRun | CheckRun): string {
  const observation = trigger.kind === "CheckRun"
    ? { kind: trigger.kind, repository: (trigger as CheckRun).spec.repositoryRef?.name, check: (trigger as CheckRun).spec.check,
      outcome: (trigger as CheckRun).status?.outcome,
      exitCode: (trigger as CheckRun).status?.exitCode, signal: (trigger as CheckRun).status?.signal,
      tests: (trigger as CheckRun).status?.failureEvidence?.tests }
    : { kind: trigger.kind, outcome: (trigger as AgentRun).status?.result?.outcome, interrupted: (trigger as AgentRun).status?.interrupted };
  return createHash("sha256").update(JSON.stringify(observation)).digest("hex");
}

export class ValidatedRecoveryRouter implements RecoveryRouter {
  private readonly reader: ResourceReader;
  private readonly schemas: ArtifactSchemaReader;
  private readonly validator: JsonSchemaValidator;
  private readonly contracts: Pick<VerificationContracts, "plan">;
  private readonly candidates?: CandidateSnapshots;
  private readonly readers?: WorkspaceReaderFactory;
  constructor(d: { reader: ResourceReader; schemas: ArtifactSchemaReader; validator: JsonSchemaValidator; contracts: Pick<VerificationContracts, "plan">;
    candidates?: CandidateSnapshots; readers?: WorkspaceReaderFactory }) {
    this.reader = d.reader;
    this.schemas = d.schemas;
    this.validator = d.validator;
    this.contracts = d.contracts;
    this.candidates = d.candidates;
    this.readers = d.readers;
  }
  signature(trigger: AgentRun | CheckRun): string { return recoveryFailureSignature(trigger); }

  async validate(item: WorkItem, run: AgentRun, report: RecoveryReport): Promise<string | undefined> {
    const schema = await this.schemas.get("recovery-report", nsOf(item));
    if (!schema || schema.version !== "1") return "The supported recovery-report schema is unavailable.";
    const problem = this.validator.validate(schema.jsonSchema, report);
    if (problem) return problem;
    const assignment = run.spec.recovery;
    if (!assignment || run.spec.replayOf || !owned(item, run)) return "The producer is not an eligible diagnostic run for this WorkItem.";
    const episode = item.status?.recovery?.find((e) => e.id === assignment.episode);
    if (!episode || episode.workItemUid !== item.metadata.uid || episode.planFingerprint !== assignment.planFingerprint ||
        episode.unit !== assignment.unit || episode.policyVersion !== assignment.policyVersion || assignment.mode !== "diagnosis" ||
        episode.disposition !== "diagnosing" || assignment.attempt !== episode.diagnosticAttempts || assignment.attempt < 1 ||
        episode.trigger.kind !== assignment.trigger.kind || episode.trigger.name !== assignment.trigger.name ||
        episode.trigger.uid !== assignment.trigger.uid) return "The diagnostic assignment does not match the current recovery episode.";
    let contract;
    try {
      contract = await this.contracts.plan(item, true);
      if (contract.fingerprint !== assignment.planFingerprint) {
        return "The approved plan has changed since this diagnostic run.";
      }
    } catch (error) {
      if (!isStoreError(error, "Invalid")) throw error;
      return `The approved plan cannot authorize this diagnosis: ${error.message}`;
    }
    if (run.status?.phase === "Succeeded" && (run.status.executor === "simulated" || run.status.provenance?.executor === "simulated")) {
      return "Simulated output cannot authorize technical recovery.";
    }
    const trigger = await this.reader.get<AgentRun | CheckRun>(assignment.trigger.kind, nsOf(item), assignment.trigger.name);
    if (!trigger || !owned(item, trigger) || trigger.metadata.uid !== assignment.trigger.uid ||
        report.episode !== episode.id || report.trigger.kind !== assignment.trigger.kind ||
        report.trigger.name !== assignment.trigger.name || report.trigger.uid !== assignment.trigger.uid ||
        report.trigger.resourceVersion !== trigger.metadata.resourceVersion) return "The trigger is missing, stale or not owned by this WorkItem.";
    if (trigger.kind === "CheckRun" && (trigger as CheckRun).spec.workflow?.planFingerprint !== assignment.planFingerprint) {
      return "The triggering check does not belong to the approved plan.";
    }
    if (trigger.kind === "CheckRun" && (!(trigger as CheckRun).status || (trigger as CheckRun).status?.phase === "Running" ||
        (trigger as CheckRun).status?.outcome === "Passed")) return "The triggering check has no completed failure evidence.";
    if (trigger.kind === "AgentRun" && ((trigger as AgentRun).spec.replayOf ||
        (trigger as AgentRun).spec.assignment?.planFingerprint !== assignment.planFingerprint)) {
      return "The triggering run does not belong to the approved plan.";
    }
    if (trigger.kind === "AgentRun" && !["Succeeded", "Failed"].includes((trigger as AgentRun).status?.phase ?? "")) {
      return "The triggering run has not completed.";
    }
    if (recoveryFailureSignature(trigger) !== report.failureSignature) return "The failure signature does not match persisted trigger evidence.";
    for (const reference of report.evidence) {
      const evidence = await this.reader.get<Evidence>(reference.kind, nsOf(item), reference.name);
      if (!evidence || !owned(item, evidence) || evidence.metadata.resourceVersion !== reference.resourceVersion ||
          (evidence.kind === "AgentRun" && (evidence as AgentRun).spec.replayOf)) {
        return `Evidence ${reference.kind}/${reference.name} is missing, stale, replayed or foreign.`;
      }
      if (evidence.kind === "AgentRun") {
        const evidenceAssignment = (evidence as AgentRun).spec.assignment;
        if (evidenceAssignment?.kind !== "unit" || evidenceAssignment.planFingerprint !== assignment.planFingerprint || evidenceAssignment.unit !== assignment.unit) {
          return `Evidence AgentRun/${reference.name} belongs to another plan or Unit.`;
        }
      }
      if (evidence.kind === "CheckRun" && ((evidence as CheckRun).spec.workflow?.planFingerprint !== assignment.planFingerprint ||
          (evidence as CheckRun).spec.workflow?.unit !== assignment.unit || (evidence as CheckRun).spec.workItemUid !== item.metadata.uid ||
          !["Completed", "Interrupted"].includes((evidence as CheckRun).status?.phase ?? ""))) {
        return `Evidence CheckRun/${reference.name} belongs to another plan.`;
      }
      if (evidence.kind === "Artifact") {
        const producer = (evidence as import("../model/kinds.ts").Artifact).spec.producedBy?.agentRunRef.name;
        const source = producer && await this.reader.get<AgentRun>("AgentRun", nsOf(item), producer);
        if (!source || !owned(item, source) || source.spec.replayOf || source.spec.assignment?.planFingerprint !== assignment.planFingerprint ||
            source.spec.assignment.kind !== "unit" || source.spec.assignment.unit !== assignment.unit) {
          return `Evidence Artifact/${reference.name} does not have an eligible producer for this plan.`;
        }
      }
    }
    if (!report.evidence.some((e) => e.kind === assignment.trigger.kind && e.name === assignment.trigger.name &&
        e.resourceVersion === trigger.metadata.resourceVersion)) return "The report must include the exact triggering evidence.";
    if (report.codeEvidence?.length) {
      if (!this.candidates || !this.readers) return "Code evidence cannot be verified without a pinned workspace.";
      const state = await this.candidates.candidate(item, contract);
      for (const code of report.codeEvidence) {
        const workspace = state.workspaces.find((w) => w.spec.repositoryRef.name === code.repository);
        if (!workspace || !contract.repositories.some((r) => r.metadata.name === code.repository) ||
            state.snapshots[workspace.metadata.name] !== code.snapshot || code.endLine < code.startLine) {
          return `Code evidence ${code.repository}/${code.path} is stale or outside the approved workspace.`;
        }
        try {
          const contents = await this.readers.forWorkspaces([workspace]).readFile(code.path);
          if (code.endLine > contents.split("\n").length) return `Code evidence ${code.path} exceeds the file's line count.`;
        } catch {
          return `Code evidence ${code.path} is not readable in the approved workspace.`;
        }
      }
    }
    return undefined;
  }

  readonly artifactCheck: ProposedArtifactCheck = {
    artifactType: "recovery-report",
    check: async ({ item, content, producer }) => {
      const run = await this.reader.get<AgentRun>("AgentRun", nsOf(item), producer.runName);
      if (!run) return "The diagnostic producer no longer exists.";
      let report: RecoveryReport;
      try { report = JSON.parse(content) as RecoveryReport; }
      catch (error) { if (error instanceof SyntaxError) return "The recovery report must be JSON."; throw error; }
      return this.validate(item, run, report);
    },
  };

  async route({ item, episode, policy, run, report }: Parameters<RecoveryRouter["route"]>[0]): Promise<RecoveryRoute> {
    const error = await this.validate(item, run, report);
    if (error) return { action: "stop", reason: error };
    if (episode.policyVersion !== policy.version) return { action: "stop", reason: "Recovery policy changed; the episode needs fresh authorization." };
    const trigger = await this.reader.get<AgentRun | CheckRun>(episode.trigger.kind, nsOf(item), episode.trigger.name);
    if (!trigger) return { action: "stop", reason: "The recovery trigger no longer exists." };
    if (report.recommendation === "repair") {
      if (trigger.kind === "CheckRun" && (trigger as CheckRun).status?.outcome !== "AssertionFailed") {
        return { action: "stop", reason: "A model recommendation cannot reclassify the recorded failure as an assertion failure." };
      }
      if (trigger.kind === "AgentRun" && (trigger as AgentRun).status?.result?.outcome !== "partial") {
        return { action: "stop", reason: "Only an authoritative partial Unit attempt can route directly to a repair." };
      }
      return { action: "repair" };
    }
    if (report.recommendation === "execution-recovery") {
      if (trigger.kind === "CheckRun" && (trigger as CheckRun).status?.outcome === "AssertionFailed") {
        return { action: "stop", reason: "Assertion failure is not an execution failure." };
      }
      return { action: "execution-recovery" };
    }
    if (report.recommendation === "human-need" && report.humanNeed) return { action: "human-need", need: report.humanNeed };
    if (report.recommendation === "diagnose") return { action: "diagnose" };
    return { action: "stop", reason: "Diagnosis recommends stopping; inspect the recovery report." };
  }
}
