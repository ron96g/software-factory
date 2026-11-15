import { createHash } from "node:crypto";
import { LABEL_SUPERSEDED, type AgentRun, type Approval, type Artifact, type CheckRun, type WorkItem } from "../model/kinds.ts";
import type { RecoveryReport } from "../model/recovery.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import { API_VERSION } from "../model/resource.ts";
import { isStoreError, StoreError, type Principal, type RecoveryAllowanceCommands, type RecoveryAllowanceReader,
  type ArtifactSchemaReader, type JsonSchemaValidator, type ResourceReader, type ResourceWriter, type VerificationContracts, type WorkflowCompiler } from "../ports/index.ts";

export class RecoveryAllowances implements RecoveryAllowanceCommands, RecoveryAllowanceReader {
  private readonly d: { namespace: string; reader: ResourceReader; writer: ResourceWriter; compiler: WorkflowCompiler; contracts: VerificationContracts;
    schemas: ArtifactSchemaReader; validator: JsonSchemaValidator };
  constructor(d: RecoveryAllowances["d"]) { this.d = d; }

  private operator(p: Principal, reason: string) {
    if (!p.roles.includes("operator") || !p.id || p.id === "anonymous") throw new StoreError("Operator authority is required.", "Invalid");
    if (typeof reason !== "string" || reason.trim().length < 10) throw new StoreError("An explicit reason of at least 10 characters is required.", "Invalid");
  }

  private async validate(item: WorkItem, allowance: NonNullable<Approval["spec"]["recoveryAllowance"]>) {
    if (item.status?.phase !== "Failed" || item.metadata.uid !== allowance.workItemUid || !item.spec.workflowRef) {
      throw new StoreError("Recovery allowance is stale or the item is not failed.", "Conflict");
    }
    const episode = item.status.recovery?.find((e) => e.id === allowance.episode);
    if (!episode || episode.disposition !== "failed" || episode.latestReport?.name !== allowance.report.name ||
        episode.latestReport.resourceVersion !== allowance.report.resourceVersion || episode.planFingerprint !== allowance.planFingerprint ||
        episode.policyVersion !== allowance.policyVersion) throw new StoreError("Recovery report or episode is stale.", "Conflict");
    const [report, workflow, contract] = await Promise.all([
      this.d.reader.get<Artifact>("Artifact", nsOf(item), allowance.report.name),
      this.d.compiler.compile(item.spec.workflowRef, nsOf(item)), this.d.contracts.plan(item, true),
    ]);
    if (!report || report.metadata.resourceVersion !== allowance.report.resourceVersion ||
        !report.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid) ||
        report.spec.artifactTypeRef.name !== "recovery-report" || report.metadata.labels?.[LABEL_SUPERSEDED] ||
        report.metadata.labels?.["factory.ai-dlc.io/replay"] || contract.fingerprint !== episode.planFingerprint ||
        workflow.recovery?.version !== episode.policyVersion) throw new StoreError("The reviewed report, plan or recovery policy is stale.", "Conflict");
    const schema = await this.d.schemas.get("recovery-report", nsOf(item));
    if (!schema || schema.version !== "1") throw new StoreError("Recovery report schema is unavailable.", "Invalid");
    let body: unknown;
    try { body = JSON.parse(report.spec.content); }
    catch (error) { if (error instanceof SyntaxError) throw new StoreError("Recovery report is malformed.", "Invalid"); throw error; }
    const problem = this.d.validator.validate(schema.jsonSchema, body);
    if (problem) throw new StoreError("Recovery report is invalid.", "Invalid");
    const reviewed = body as RecoveryReport;
    if (reviewed.episode !== episode.id || reviewed.trigger.kind !== episode.trigger.kind ||
        reviewed.trigger.name !== episode.trigger.name || reviewed.trigger.uid !== episode.trigger.uid) {
      throw new StoreError("Recovery report belongs to another episode or trigger.", "Invalid");
    }
    const trigger = await this.d.reader.get<AgentRun | CheckRun>(episode.trigger.kind, nsOf(item), episode.trigger.name);
    if (!trigger || trigger.metadata.uid !== episode.trigger.uid || trigger.metadata.resourceVersion !== reviewed.trigger.resourceVersion ||
        !trigger.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid)) {
      throw new StoreError("Recovery report trigger is stale.", "Conflict");
    }
    const used = item.status.recovery!.filter((e) => e.planFingerprint === episode.planFingerprint && e.unit === episode.unit)
      .reduce((n, e) => n + e.operatorAllowance, 0);
    if (!Number.isInteger(allowance.count) || allowance.count < 1 || used + allowance.count > workflow.recovery.maxOperatorAllowance ||
        !["diagnosis", "repair", "execution-recovery"].includes(allowance.target)) {
      throw new StoreError("Recovery allowance exceeds operator allocation policy.", "Invalid");
    }
    return episode;
  }

  async request(p: Principal, name: string, input: { requestId: string; count: number; target: "diagnosis" | "repair" | "execution-recovery"; reason: string }): Promise<Approval> {
    this.operator(p, input.reason);
    if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200) {
      throw new StoreError("A stable requestId of at most 200 characters is required.", "Invalid");
    }
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item?.metadata.uid) throw new StoreError("Work item not found.", "NotFound");
    const hash = createHash("sha256").update(JSON.stringify([item.metadata.uid, input.requestId])).digest("hex").slice(0, 24);
    const approvalName = `${item.metadata.name.slice(0, 130)}-recovery-allowance-${hash}`;
    const existing = await this.d.reader.get<Approval>("Approval", nsOf(item), approvalName);
    const receipt = (approval: Approval): Approval => {
      const saved = approval.spec.recoveryAllowance;
      if (!saved || saved.workItemUid !== item.metadata.uid || saved.requestId !== input.requestId || saved.requestedBy !== p.id ||
          saved.requestReason !== input.reason.trim() || saved.count !== input.count || saved.target !== input.target) {
        throw new StoreError("Recovery allowance requestId was already used with different input.", "Conflict");
      }
      return approval;
    };
    if (existing) return receipt(existing);
    const episode = item?.status?.recovery?.findLast((e) => e.disposition === "failed");
    if (!episode?.latestReport) throw new StoreError("No failed recovery report is available.", "Invalid");
    const recoveryAllowance = { workItemUid: item.metadata.uid, episode: episode.id, report: episode.latestReport,
      planFingerprint: episode.planFingerprint, policyVersion: episode.policyVersion, count: input.count, target: input.target,
      requestId: input.requestId, requestedBy: p.id, requestReason: input.reason.trim() };
    await this.validate(item, recoveryAllowance);
    const approval: Approval = { apiVersion: API_VERSION, kind: "Approval", metadata: {
      name: approvalName, namespace: nsOf(item), ownerReferences: [ownerRef(item)] },
      spec: { workItemRef: { name }, stage: episode.stage, approvers: [{ role: "operator" }], recoveryAllowance,
        criteria: [`Allocation only; no gate, waiver or publication permission. Requested by ${p.id}: ${input.reason.trim()}`] },
      status: { phase: "Pending" } };
    try { return await this.d.writer.create(approval); }
    catch (error) {
      if (!isStoreError(error, "AlreadyExists")) throw error;
      const created = await this.d.reader.get<Approval>("Approval", nsOf(item), approvalName);
      if (!created) throw error;
      return receipt(created);
    }
  }

  async decide(p: Principal, name: string, decision: "approve" | "reject", reason: string): Promise<Approval> {
    this.operator(p, reason);
    if (decision !== "approve" && decision !== "reject") throw new StoreError("Invalid decision.", "Invalid");
    const approval = await this.d.reader.get<Approval>("Approval", this.d.namespace, name);
    if (!approval?.spec.recoveryAllowance || approval.spec.decision) throw new StoreError("Allowance is missing or already decided.", "Conflict");
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, approval.spec.workItemRef.name);
    if (!item) throw new StoreError("Work item not found.", "NotFound");
    await this.validate(item, approval.spec.recoveryAllowance);
    return this.d.writer.update({ ...approval, spec: { ...approval.spec, decision, decidedBy: p.id, comment: reason.trim() } });
  }

  async approved(item: WorkItem): Promise<{ approval: Approval; staleReason?: string } | undefined> {
    const approvals = await this.d.reader.list<Approval>("Approval", { namespace: nsOf(item),
      ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) } });
    for (const approval of approvals) {
      if (approval.spec.decision !== "approve" || !approval.spec.recoveryAllowance ||
          item.status?.staleRecoveryAllowances?.includes(approval.metadata.name) ||
          item.status?.recovery?.some((e) => e.consumedAllowances?.includes(approval.metadata.name))) continue;
      const allocation = approval.spec.recoveryAllowance;
      const episode = item.status?.recovery?.find((e) => e.id === allocation.episode && e.disposition === "failed");
      if (!episode || episode.latestReport?.name !== allocation.report.name ||
          episode.latestReport.resourceVersion !== allocation.report.resourceVersion ||
          episode.planFingerprint !== allocation.planFingerprint || episode.policyVersion !== allocation.policyVersion) {
        return { approval, staleReason: "The approved recovery episode or report has changed." };
      }
      try { await this.validate(item, allocation); }
      catch (error) {
        if (isStoreError(error, "Conflict") || isStoreError(error, "Invalid") && error.message !== "Recovery report schema is unavailable.") {
          return { approval, staleReason: error.message };
        }
        throw error;
      }
      return { approval };
    }
    return undefined;
  }
}
