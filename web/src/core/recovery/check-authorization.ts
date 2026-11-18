import { LABEL_SUPERSEDED, type Agent, type AgentRun, type CheckRun, type WorkItem, type Workspace } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { unitChecks } from "../model/units.ts";
import { canPrepareIsolated, StoreError, type ExecutionEnvironmentSelector, type RecoveryCheckAuthorization, type ResourceReader, type VerificationContracts, type WorkflowCompiler } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { checkDefinitionVersion } from "../checks/definition-version.ts";

/** Revalidates scheduler and controller callers against persisted resources and approved Unit scope. */
export class DefaultRecoveryCheckAuthorization implements RecoveryCheckAuthorization {
  private readonly d: { reader: ResourceReader; compiler: WorkflowCompiler; contracts: Pick<VerificationContracts, "plan">; environments?: ExecutionEnvironmentSelector };
  constructor(d: DefaultRecoveryCheckAuthorization["d"]) { this.d = d; }

  async authorize(input: Parameters<RecoveryCheckAuthorization["authorize"]>[0]): Promise<void> {
    const fail = (message: string): never => { throw new StoreError(message, "Invalid"); };
    const { origin, check, repository, existing } = input;
    const ns = nsOf(input.item);
    const item = await this.d.reader.get<WorkItem>("WorkItem", ns, input.item.metadata.name);
    const caller = await this.d.reader.get<AgentRun>("AgentRun", ns, input.caller.metadata.name);
    const workspace = await this.d.reader.get<Workspace>("Workspace", ns, input.workspace.metadata.name);
    if (!item?.metadata.uid || item.metadata.uid !== input.item.metadata.uid || !caller?.metadata.uid ||
        caller.metadata.uid !== input.caller.metadata.uid || !workspace?.metadata.uid || workspace.metadata.uid !== input.workspace.metadata.uid ||
        !caller.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid) ||
        !workspace.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid) ||
        workspace.spec.repositoryRef.name !== repository.metadata.name) return fail("Recovery check caller or workspace is stale or foreign.");
    const tool = origin.purpose === "baseline" ? "run_baseline_check" : "run_check";
    if (caller.spec.replayOf || caller.metadata.labels?.[LABEL_SUPERSEDED] || caller.status?.phase !== "Running" ||
        caller.spec.workItemRef.name !== item.metadata.name || caller.spec.tools && !caller.spec.tools.includes(tool)) {
      return fail("Recovery check caller is not an active authorized run.");
    }
    if (!item.spec.workflowRef) return fail("Recovery workflow is missing.");
    const workflow = await this.d.compiler.compile(item.spec.workflowRef, ns);
    if (!workflow.recovery || caller.spec.stage !== workflow.verification?.implementationStage) return fail("Recovery check is not enabled for this stage.");
    const stage = workflow.stage(caller.spec.stage);
    const diagnostic = caller.spec.recovery?.mode === "diagnosis";
    const step = stage?.steps.find((s) => (diagnostic || s.name === caller.spec.step) && s.agentRef.name === caller.spec.agentRef.name);
    const agent = await resolveRef<Agent>(this.d.reader, "Agent", caller.spec.agentRef, ns);
    if (!step || !agent || !["Running", "Waiting"].includes(item.status?.phase ?? "") ||
        item.status?.stage !== origin.stage || item.status?.round !== origin.round ||
        caller.metadata.labels?.["factory.ai-dlc.io/stage"] !== origin.stage ||
        caller.metadata.labels?.["factory.ai-dlc.io/workitem"] !== item.metadata.name ||
        (!diagnostic && !caller.metadata.name.endsWith(`-r${origin.round}`)) || !agent.spec.tools?.includes("write_file") ||
        !agent.spec.tools?.includes("run")) return fail("Recovery check caller is not the active implementation role.");
    const contract = await this.d.contracts.plan(item, true);
    const approvedRepository = contract.repositories.find((r) => r.metadata.name === repository.metadata.name);
    if (!approvedRepository || approvedRepository.metadata.uid !== repository.metadata.uid ||
        checkDefinitionVersion(approvedRepository) !== checkDefinitionVersion(repository)) return fail("Repository policy changed.");
    const assignment = caller.spec.assignment;
    if (!assignment || assignment.kind !== "unit" || assignment.planFingerprint !== contract.fingerprint ||
        origin.planFingerprint !== contract.fingerprint || origin.unit !== assignment.unit ||
        origin.agentRunRef?.name !== caller.metadata.name || origin.agentRunUid !== caller.metadata.uid ||
        origin.stage !== caller.spec.stage) return fail("Recovery check assignment is not bound to the approved plan and active caller.");
    const unit = contract.plan.units?.find((u) => u.id === assignment.unit);
    if (!unit) return fail("Recovery check Unit is not approved.");
    if (origin.purpose === "diagnostic" || origin.purpose === "baseline") {
      const rec = caller.spec.recovery;
      const episode = item.status?.recovery?.find((e) => e.id === rec?.episode);
      if (!diagnostic || !rec || !episode || episode.disposition !== "diagnosing" || episode.workItemUid !== item.metadata.uid ||
          episode.planFingerprint !== contract.fingerprint || episode.unit !== unit.id || episode.policyVersion !== workflow.recovery.version ||
          episode.diagnosticAttempts !== rec.attempt || rec.unit !== unit.id || rec.planFingerprint !== contract.fingerprint ||
          origin.recoveryEpisode !== episode.id || rec.trigger.uid !== episode.trigger.uid || rec.trigger.kind !== episode.trigger.kind ||
          rec.trigger.name !== episode.trigger.name || rec.policyVersion !== episode.policyVersion ||
          caller.spec.step !== `diagnosis-${episode.id}` ||
          caller.metadata.name !== `${item.metadata.name.slice(0, 130)}-recovery-${episode.id}-d${rec.attempt}` ||
          !workflow.recovery.diagnosticChecks.includes(`${repository.metadata.name}/${check}`) ||
          step.tools !== undefined && !step.tools.includes(tool) ||
          (origin.purpose === "baseline" && (!workspace.status?.baseCommit || origin.baselineCommit !== workspace.status.baseCommit))) {
        return fail("Diagnostic caller or check is outside the authorized episode.");
      }
      if (!this.d.environments) return fail("Isolated diagnostic runtime is unavailable.");
      const selected = await this.d.environments.select();
      if (!selected.health.available || !canPrepareIsolated(selected.environment) || !selected.environment.isolatesCandidate) {
        return fail("Diagnostic checks require a trusted isolated adapter.");
      }
      const all = await this.d.reader.list<CheckRun>("CheckRun", { namespace: ns,
        ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: ns } });
      const relevant = all.filter((r) => r.spec.workItemUid === item.metadata.uid && r.spec.workflow?.purpose === origin.purpose &&
        r.spec.workflow.planFingerprint === contract.fingerprint && r.spec.workflow.unit === unit.id &&
        r.spec.repositoryRef.name === repository.metadata.name && r.spec.check === check);
      if (existing) {
        if (!relevant.some((r) => r.metadata.uid === existing.metadata.uid && r.metadata.name === existing.metadata.name) ||
            existing.spec.workspaceUid !== workspace.metadata.uid || JSON.stringify(existing.spec.workflow) !== JSON.stringify(origin)) {
          return fail("Existing diagnostic check identity does not match.");
        }
        return;
      }
      const scope = item.status?.recovery?.filter((e) => e.planFingerprint === contract.fingerprint && e.unit === unit.id) ?? [];
      const used = scope.reduce((n, e) => n + e.diagnosticAttempts + e.codeAttempts + e.executionAttempts, 0) +
        all.filter((r) => r.spec.workItemUid === item.metadata.uid && ["diagnostic", "baseline"].includes(r.spec.workflow?.purpose ?? "") &&
          r.spec.workflow?.planFingerprint === contract.fingerprint && r.spec.workflow?.unit === unit.id).length;
      const allowance = scope.reduce((n, e) => n + e.operatorAllowance, 0);
      if (used >= episode.maxTotalAttempts + allowance - (scope.some((e) => e.humanNeedConsumed) ? 0 : workflow.recovery.humanNeedReserve) ||
          relevant.length >= contract.unitPolicy!.maxExecutionAttempts || origin.attempt !== relevant.length + 1) {
        return fail("Diagnostic check execution budget is exhausted or the attempt is stale.");
      }
      return;
    }
    if (origin.purpose !== "unit-readiness" || caller.spec.recovery?.mode === "diagnosis" ||
        origin.unitRun !== caller.metadata.name || !unitChecks(unit).includes(`${repository.metadata.name}/${check}`) ||
        !repository.spec.verification?.readinessChecks?.includes(check)) return fail("Check is not an approved readiness check for this Unit.");
    const runs = await this.d.reader.list<CheckRun>("CheckRun", { namespace: ns,
      ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: ns } });
    const relevant = runs.filter((r) => r.spec.workItemUid === item.metadata.uid && r.spec.workflow?.purpose === "unit-readiness" &&
      r.spec.workflow.planFingerprint === contract.fingerprint && r.spec.workflow.unit === unit.id &&
      r.spec.repositoryRef.name === repository.metadata.name && r.spec.check === check);
    if (existing) {
      if (!relevant.some((r) => r.metadata.uid === existing.metadata.uid && r.metadata.name === existing.metadata.name) ||
          existing.spec.workflow?.agentRunUid !== caller.metadata.uid || existing.spec.workspaceUid !== workspace.metadata.uid ||
          existing.spec.repositoryRef.name !== repository.metadata.name || existing.spec.check !== check ||
          JSON.stringify(existing.spec.workflow) !== JSON.stringify(origin)) return fail("Existing recovery check identity does not match.");
      return;
    }
    if (relevant.length >= contract.unitPolicy!.maxExecutionAttempts) return fail("The Unit readiness execution budget is exhausted.");
    if (origin.attempt !== relevant.length + 1) return fail("Recovery check attempt does not match durable Unit history.");
  }
}
