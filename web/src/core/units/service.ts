import { createHash } from "node:crypto";
import { scopeSatisfies } from "../model/check-scope.ts";
import { BARRIER_UNIT, LABEL_SUPERSEDED, type AgentRun, type Artifact, type CheckRun, type UnitAssignment, type WorkItem, type Workspace } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { allUnitChecks, nextUnit, unitChecks, type PlannedUnit } from "../model/units.ts";
import {
  SandboxUnavailableError, StoreError, isStoreError,
  type CandidateCompleteness, type CandidateSnapshots, type CandidateState, type CheckRunScheduler, type Clock, type CompiledStage,
  type EventRecorder, type GateContext, type GateDecision, type GateEvaluator, type Principal, type Redactor, type ResourceReader,
  type RunFailurePolicy, type StepAssignmentPolicy, type UnitLedgerReader, type UnitProgress, type UnitProgressQueries, type UnitProgressView,
  type ValidationContract, type VerificationContracts, type WorkflowCompiler, type WorkspaceReaderFactory,
} from "../ports/index.ts";
import { checkDefinitionVersion } from "../checks/definition-version.ts";

export const UNIT_PROGRESS_GATE = "unit-progress";
export const UNIT_RESULT_ARTIFACT = "unit-result";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message: string): never => { throw new StoreError(message, "Invalid"); };
const owned = (wi: WorkItem) => ({ namespace: nsOf(wi), ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: nsOf(wi) } });
const eligible = (r: { metadata: { labels?: Record<string, string> } }) =>
  !r.metadata.labels?.[LABEL_SUPERSEDED] && !r.metadata.labels?.["factory.ai-dlc.io/replay"];
const active = (run: CheckRun) => !run.status || run.status.phase === "Running";
const roundOf = (name: string) => Number(/-r(\d+)$/.exec(name)?.[1] ?? 0);
const passed = (run: CheckRun) => run.status?.phase === "Completed" && run.status.outcome === "Passed" && !run.status.logsIncomplete &&
  run.status.finalSnapshot === run.spec.snapshot;

interface Deps {
  namespace: string;
  reader: ResourceReader;
  compiler: WorkflowCompiler;
  contracts: VerificationContracts;
  candidates: CandidateSnapshots;
  scheduler: CheckRunScheduler;
  readers: WorkspaceReaderFactory;
  events: EventRecorder;
  clock: Clock;
  redactor: Redactor;
}

interface UnitLedgerEntry {
  unit: PlannedUnit;
  ready: boolean;
  run?: AgentRun;
  diagnostics: string[];
  checks: UnitProgress["checks"];
}

/**
 * ADR-0047: implements approved Units one at a time and blocks review until every Unit has current readiness
 * evidence. Progress is derived from durable AgentRuns, Artifacts and CheckRuns (level-triggered, restart-safe);
 * this service never writes WorkItem status: the WorkItem controller applies its decisions.
 */
export class UnitExecutionService implements StepAssignmentPolicy, RunFailurePolicy, CandidateCompleteness, UnitProgressQueries, UnitLedgerReader {
  readonly gate: GateEvaluator;
  private readonly d: Deps;

  constructor(d: Deps) {
    this.d = d;
    this.gate = { type: UNIT_PROGRESS_GATE, evaluate: (ctx) => this.evaluate(ctx) };
  }

  /** Real, current, non-replayed implementation attempts bound to this exact approved plan. */
  private async attempts(item: WorkItem, contract: ValidationContract) {
    const runs = await this.d.reader.list<AgentRun>("AgentRun", owned(item));
    return runs.filter((r) => eligible(r) && !r.spec.replayOf && r.spec.stage === contract.policy.implementationStage &&
      r.spec.recovery?.mode !== "diagnosis" &&
      r.spec.assignment?.planFingerprint === contract.fingerprint && r.metadata.ownerReferences?.some((o) => o.uid === item.metadata.uid))
      .sort((a, b) => roundOf(a.metadata.name) - roundOf(b.metadata.name));
  }

  private async checkRuns(item: WorkItem, contract: ValidationContract) {
    return (await this.d.reader.list<CheckRun>("CheckRun", owned(item))).filter((r) => eligible(r) && r.spec.workItemUid === item.metadata.uid &&
      r.spec.workflow?.purpose === "unit-readiness" && r.spec.workflow.planFingerprint === contract.fingerprint);
  }

  /** Structural check of a recorded result; workspace paths are probed only when the attempt is first evaluated. */
  private async result(run: AgentRun, unit: PlannedUnit, artifacts: Artifact[], workspaces?: Workspace[]): Promise<string[]> {
    const reasons: string[] = [];
    if (run.status?.phase !== "Succeeded") return [`attempt ${run.metadata.name} has not succeeded`];
    if (!run.status.executor || run.status.executor === "simulated" || run.status.provenance?.executor === "simulated") {
      return ["simulated output is not Unit evidence"];
    }
    if (run.status.result?.outcome !== "complete") reasons.push(`the developer reported outcome "${run.status.result?.outcome ?? "none"}", not "complete"`);
    const artifact = artifacts.find((a) => eligible(a) && a.spec.producedBy?.agentRunRef.name === run.metadata.name &&
      a.spec.artifactTypeRef.name === UNIT_RESULT_ARTIFACT);
    if (!artifact) return [...reasons, `no ${UNIT_RESULT_ARTIFACT} artifact was produced`];
    let parsed: unknown;
    try { parsed = JSON.parse(artifact.spec.content); } catch { return [...reasons, `${UNIT_RESULT_ARTIFACT} is not a JSON object`]; }
    const body = parsed as { unit?: unknown; outcome?: unknown; obligations?: unknown };
    if (!body || typeof body !== "object" || body.unit !== unit.id) return [...reasons, `${UNIT_RESULT_ARTIFACT} must name Unit ${unit.id}`];
    if (body.outcome !== "complete") reasons.push(`${UNIT_RESULT_ARTIFACT} outcome is ${JSON.stringify(body.outcome)}`);
    const reported = Array.isArray(body.obligations) ? body.obligations as { id?: unknown; status?: unknown; evidence?: unknown }[] : [];
    const paths: string[] = [];
    for (const o of unit.obligations) {
      const matches = reported.filter((r) => r?.id === o.id);
      if (matches.length !== 1) { reasons.push(`obligation ${o.id} must be reported exactly once`); continue; }
      const [entry] = matches;
      if (entry.status !== "done") { reasons.push(`obligation ${o.id} is ${JSON.stringify(entry.status ?? "unreported")}`); continue; }
      const evidence = Array.isArray(entry.evidence) ? entry.evidence as { path?: unknown }[] : [];
      const files = evidence.map((e) => e?.path).filter((p): p is string => typeof p === "string" && !!p.trim());
      if (!files.length) reasons.push(`obligation ${o.id} has no workspace file evidence`);
      paths.push(...files);
    }
    const unknown = reported.filter((r) => !unit.obligations.some((o) => o.id === r?.id)).map((r) => String(r?.id));
    if (unknown.length) reasons.push(`unknown obligations reported: ${unknown.join(", ")}`);
    if (workspaces && !reasons.length) {
      const files = this.d.readers.forWorkspaces(workspaces);
      for (const path of [...new Set(paths)]) {
        try { await files.readFile(path); } catch { reasons.push(`evidence file ${path} does not exist in the workspace`); }
      }
    }
    return reasons;
  }

  private async ledger(item: WorkItem, contract: ValidationContract): Promise<UnitLedgerEntry[]> {
    const units = contract.plan.units ?? [];
    const attempts = await this.attempts(item, contract);
    const artifacts = await this.d.reader.list<Artifact>("Artifact", owned(item));
    const checks = await this.checkRuns(item, contract);
    const entries: UnitLedgerEntry[] = [];
    for (const unit of units) {
      const runs = attempts.filter((r) => r.spec.assignment?.kind === "unit" && r.spec.assignment.unit === unit.id);
      let entry: UnitLedgerEntry = { unit, ready: false, run: runs.at(-1), diagnostics: [], checks: [] };
      for (const run of [...runs].reverse()) {
        const reasons = await this.result(run, unit, artifacts);
        const evidence = unitChecks(unit).map((id) => {
          const [repository, check] = id.split("/");
          const last = checks.filter((c) => c.spec.workflow?.unit === unit.id && c.spec.workflow.unitRun === run.metadata.name &&
            c.spec.repositoryRef.name === repository && c.spec.check === check).at(-1);
          return { id, checkRun: last?.metadata.name, outcome: last ? last.status?.outcome ?? "Pending" : undefined, snapshot: last?.spec.snapshot, ok: !!last && passed(last) };
        });
        const ready = !reasons.length && evidence.every((e) => e.ok);
        const diagnostics = [...reasons, ...evidence.filter((e) => !e.ok).map((e) => `${e.id}: ${e.outcome ?? "not run"}`)];
        if (ready || run === runs.at(-1)) entry = { unit, ready, run, diagnostics: ready ? [] : diagnostics, checks: evidence.map(({ ok: _ok, ...rest }) => rest) };
        if (ready) break;
      }
      if (!runs.length) entry.diagnostics = ["not started"];
      entries.push(entry);
    }
    return entries;
  }

  private async contract(item: WorkItem) {
    const contract = await this.d.contracts.plan(item, true);
    if (!contract.unitPolicy || !contract.plan.units?.length) return invalid("workflow or approved plan has no unit execution contract");
    return contract;
  }

  private retry(item: WorkItem, key: string, max: number, stage: string, exhausted: string): GateDecision {
    if ((item.status?.retries?.[key] ?? 0) >= max) return { action: "block", questions: [exhausted] };
    return { action: "goto", stage, retryOf: key };
  }

  private async recovery(item: WorkItem, contract: ValidationContract, trigger: AgentRun | CheckRun, unit: string): Promise<GateDecision | undefined> {
    if (!item.spec.workflowRef || !(await this.d.compiler.compile(item.spec.workflowRef, nsOf(item))).recovery) return undefined;
    if (!trigger.metadata.uid) return { action: "fail", reason: "Recovery trigger has no durable identity." };
    return { action: "recovery", trigger: { kind: trigger.kind as "AgentRun" | "CheckRun", name: trigger.metadata.name, uid: trigger.metadata.uid },
      planFingerprint: contract.fingerprint, unit };
  }

  private async submit(item: WorkItem, contract: ValidationContract, state: CandidateState, id: string, origin: { stage: string; unit: string; unitRun?: string },
    attempt: number): Promise<GateDecision> {
    const [repository, check] = id.split("/");
    const repo = contract.repositories.find((r) => r.metadata.name === repository)!;
    const workspace = state.workspaces.find((w) => w.spec.repositoryRef.name === repository);
    if (!workspace) return { action: "block", questions: [`Ready workspace missing for ${repository}; restore it before Unit readiness can be established.`] };
    try {
      await this.d.scheduler.submit({ workItem: item, workspace, repository: repo, check, requestedBy: "unit-execution",
        // The round keeps identities unique after restarts supersede earlier jobs at the same snapshot.
        requestId: `unit-readiness/${digest([contract.fingerprint, origin.unit, origin.unitRun, id, state.snapshots[workspace.metadata.name], item.status?.round, attempt])}`,
        workflow: { stage: origin.stage, round: item.status!.round!, purpose: "unit-readiness", planFingerprint: contract.fingerprint, attempt,
          unit: origin.unit, ...(origin.unitRun ? { unitRun: origin.unitRun } : {}) } });
    } catch (error) {
      if (isStoreError(error, "Conflict")) return { action: "wait", retryAfterMs: 1000 };
      if (error instanceof SandboxUnavailableError) return { action: "block", questions: [this.d.redactor.redact(
        `Unit readiness runtime unavailable (${error.runtime}): ${error.message}. Restore it and answer to retry; no code-fix attempt was charged.`)] };
      throw error;
    }
    return { action: "wait", retryAfterMs: 1000 };
  }

  /**
   * One readiness check: wait, continue (undefined), retry with a new attempt, route to a code fix or stop.
   * Execution attempts are budgeted per round, so a human answer grants one new bounded try instead of re-blocking.
   */
  private async readiness(item: WorkItem, contract: ValidationContract, state: CandidateState, id: string,
    runs: CheckRun[], origin: { stage: string; unit: string; unitRun?: string }, codeKey: string): Promise<GateDecision | undefined> {
    const policy = contract.unitPolicy!;
    const [repository, check] = id.split("/");
    const workspace = state.workspaces.find((w) => w.spec.repositoryRef.name === repository);
    const snapshot = workspace && state.snapshots[workspace.metadata.name];
    const attempts = runs.filter((r) => r.spec.repositoryRef.name === repository && r.spec.check === check &&
      r.spec.workspaceUid === workspace?.metadata.uid && r.spec.snapshot === snapshot);
    if (attempts.some(active)) return { action: "wait", retryAfterMs: 1000 };
    if (attempts.some(passed)) return undefined;
    const recoveryEnabled = !!item.spec.workflowRef && !!(await this.d.compiler.compile(item.spec.workflowRef, nsOf(item))).recovery;
    if (recoveryEnabled) {
      const history = (await this.checkRuns(item, contract)).filter((r) => r.spec.repositoryRef.name === repository && r.spec.check === check &&
        r.spec.workflow?.unit === origin.unit);
      if (history.some(active)) return { action: "wait", retryAfterMs: 1000 };
      const last = attempts.at(-1);
      if (last && !passed(last)) return (await this.recovery(item, contract, last, origin.unit))!;
      if (history.length >= policy.maxExecutionAttempts && history.length) return (await this.recovery(item, contract, history.at(-1)!, origin.unit))!;
    }
    const current = attempts.filter((r) => r.spec.workflow?.round === item.status?.round);
    const last = current.at(-1);
    if (last?.status?.outcome === "AssertionFailed") {
      const recovery = await this.recovery(item, contract, last, origin.unit);
      if (recovery) return recovery;
      return this.retry(item, codeKey, policy.maxCodeAttempts, contract.policy.implementationStage,
        `${id} still fails for ${origin.unit === BARRIER_UNIT ? "the complete candidate" : `Unit ${origin.unit}`} after the code-fix budget. Inspect CheckRun ${last.metadata.name}; answer to allow one more bounded attempt or revise the plan.`);
    }
    if (last && current.length >= policy.maxExecutionAttempts) {
      const recovery = await this.recovery(item, contract, last, origin.unit);
      if (recovery) return recovery;
      return { action: "block", questions: [`${id}: ${last.status?.outcome ?? "Interrupted"} after ${current.length} readiness execution attempt(s). No code fix was charged. Inspect CheckRun ${last.metadata.name}, fix prerequisites or budget, then answer to retry.`] };
    }
    const retryAt = last?.status?.finishedAt ? Date.parse(last.status.finishedAt) + contract.policy.retryDelayMs : 0;
    if (retryAt > this.d.clock.now().getTime()) return { action: "wait", retryAfterMs: retryAt - this.d.clock.now().getTime() };
    return this.submit(item, contract, state, id, origin, attempts.length + 1);
  }

  private async evaluate(ctx: GateContext): Promise<GateDecision> {
    const item = ctx.workItem;
    try {
      const contract = await this.contract(item);
      const policy = contract.unitPolicy!;
      if (ctx.stage.name !== contract.policy.implementationStage) return { action: "fail", reason: "unit-progress gate is not on the implementation stage" };
      const round = item.status?.round;
      const run = (await this.attempts(item, contract)).find((r) => roundOf(r.metadata.name) === round && r.spec.assignment);
      if (!run) return this.retry(item, "unit-assignment", policy.maxExecutionAttempts, contract.policy.implementationStage,
        "The implementation attempt is not bound to the current approved plan. Restart implementation after checking the plan.");
      const assignment = run.spec.assignment as UnitAssignment;
      if (assignment.kind === "repair") {
        if (run.status?.executor === "simulated") {
          return this.retry(item, "unit-repair", policy.maxCodeAttempts, contract.policy.implementationStage,
            "The cross-Unit repair only ran on the simulated executor. Make a real executor available, then answer to retry.");
        }
        // Every Unit is already ready, so an unfinished repair concerns review findings, not completeness. Retrying here
        // would nest a second loop inside the review loop; the barrier still guards the candidate and the review gate decides.
        if (run.status?.result?.outcome !== "complete") {
          await this.d.events.warning(item, "RepairIncomplete",
            `${run.metadata.name} ended ${run.status?.result?.outcome ?? "without outcome"}; open findings go to code review. ${run.status?.result?.summary ?? ""}`.trim());
        }
        return { action: "advance" };
      }
      const units = contract.plan.units!;
      const unit = units.find((u) => u.id === assignment.unit)!;
      const state = await this.d.candidates.candidate(item, contract);
      const artifacts = await this.d.reader.list<Artifact>("Artifact", owned(item));
      const checks = (await this.checkRuns(item, contract)).filter((r) => r.spec.workflow?.unit === unit.id && r.spec.workflow.unitRun === run.metadata.name);
      // Structure and file evidence are only evaluated before readiness checks start; later Units may move files.
      if (!checks.length) {
        const reasons = await this.result(run, unit, artifacts, state.workspaces);
        if (reasons.length) {
          const recovery = await this.recovery(item, contract, run, unit.id);
          if (recovery) return recovery;
          const decision = this.retry(item, `unit:${unit.id}`, policy.maxCodeAttempts, contract.policy.implementationStage,
            `Unit ${unit.id} (${unit.title}) is still incomplete after ${policy.maxCodeAttempts + 1} attempt(s): ${reasons.join("; ")}. ` +
            "Answer with guidance for one more attempt, or restart from the plan if the Unit is wrong.");
          return decision.action === "block" && run.status?.result?.summary
            ? { ...decision, details: `**Developer's last summary (${run.metadata.name})**\n\n${run.status.result.summary}` } : decision;
        }
      }
      for (const id of unitChecks(unit)) {
        const decision = await this.readiness(item, contract, state, id, checks, { stage: ctx.stage.name, unit: unit.id, unitRun: run.metadata.name }, `unit:${unit.id}`);
        if (decision) return decision;
      }
      const ready = new Set((await this.ledger(item, contract)).filter((e) => e.ready).map((e) => e.unit.id));
      if (!ready.has(unit.id)) return { action: "wait", retryAfterMs: 1000 };
      const next = nextUnit(units, ready);
      await this.d.events.normal(item, "UnitReady", `${unit.id} ready (${ready.size}/${units.length})${next ? `; next ${next.id}` : "; all Units ready for review"}`);
      return next ? { action: "goto", stage: contract.policy.implementationStage } : { action: "advance" };
    } catch (e) {
      if (isStoreError(e, "Conflict")) return { action: "wait", retryAfterMs: 1000 };
      if (!isStoreError(e, "Invalid")) throw e;
      return { action: "block", questions: [e.message] };
    }
  }

  async assign(item: WorkItem, stage: CompiledStage): Promise<UnitAssignment | undefined> {
    if (!item.spec.workflowRef) return undefined;
    const workflow = await this.d.compiler.compile(item.spec.workflowRef, nsOf(item));
    if (!workflow.unitExecution || workflow.verification?.implementationStage !== stage.name) return undefined;
    const contract = await this.contract(item);
    const ledger = await this.ledger(item, contract);
    const next = nextUnit(contract.plan.units!, new Set(ledger.filter((e) => e.ready).map((e) => e.unit.id)));
    return next ? { kind: "unit", planFingerprint: contract.fingerprint, unit: next.id } : { kind: "repair", planFingerprint: contract.fingerprint };
  }

  async recover(item: WorkItem, _stage: CompiledStage, run: AgentRun): Promise<GateDecision | undefined> {
    if (!run.spec.assignment || !run.status?.interrupted) return undefined;
    let contract: ValidationContract;
    try { contract = await this.contract(item); }
    catch (e) {
      if (!isStoreError(e, "Invalid")) throw e;
      return { action: "block", questions: [`Interrupted attempt ${run.metadata.name} cannot be retried: ${e.message}`] };
    }
    const label = run.spec.assignment.kind === "unit" ? run.spec.assignment.unit : "repair";
    const recovery = await this.recovery(item, contract, run, label);
    if (recovery) return recovery;
    return this.retry(item, `unit-exec:${label}`, contract.unitPolicy!.maxExecutionAttempts, contract.policy.implementationStage,
      `Implementation attempt ${run.metadata.name} (${label}) was interrupted ${contract.unitPolicy!.maxExecutionAttempts} time(s). Inspect the workspace, then answer to retry.`);
  }

  /** Readiness evidence that still describes the current candidate tree, repository policy and environment. */
  private fresh(contract: ValidationContract, state: CandidateState, run: CheckRun) {
    const repository = run.spec.repositoryRef.name;
    const repo = contract.repositories.find((r) => r.metadata.name === repository);
    const workspace = state.workspaces.find((w) => w.spec.repositoryRef.name === repository);
    return !!repo && !!workspace && run.spec.workspaceUid === workspace.metadata.uid && run.spec.repositoryVersion === checkDefinitionVersion(repo) &&
      scopeSatisfies(repo, run.spec.check, run, "unit-readiness") &&
      run.spec.snapshot === state.snapshots[workspace.metadata.name] && run.spec.environment.runtime === state.health.runtime &&
      run.spec.environment.version === state.health.version && run.spec.environment.profileVersion === state.profiles[repository];
  }

  /** Readiness checks without passing evidence for the current candidate; empty when the barrier is satisfied. */
  private staleChecks(contract: ValidationContract, state: CandidateState, runs: CheckRun[]) {
    return allUnitChecks(contract.plan.units!).filter((id) => !runs.some((r) => passed(r) && this.fresh(contract, state, r) &&
      `${r.spec.repositoryRef.name}/${r.spec.check}` === id));
  }

  private gaps(contract: ValidationContract, state: CandidateState, ledger: UnitLedgerEntry[], runs: CheckRun[]) {
    return [...ledger.filter((e) => !e.ready).map((e) => `Unit ${e.unit.id} not ready`),
      ...this.staleChecks(contract, state, runs).map((id) => `${id} has no passing readiness evidence for the current candidate`)];
  }

  async beforeCandidate(item: WorkItem, stage: CompiledStage, contract: ValidationContract): Promise<GateDecision> {
    const policy = contract.unitPolicy!;
    const ledger = await this.ledger(item, contract);
    const incomplete = ledger.filter((e) => !e.ready);
    if (incomplete.length) {
      return this.retry(item, "unit-barrier", policy.maxExecutionAttempts, contract.policy.implementationStage,
        `Review cannot start: Units ${incomplete.map((e) => e.unit.id).join(", ")} are not ready. Restart implementation after resolving: ${incomplete.flatMap((e) => e.diagnostics).slice(0, 6).join("; ")}`);
    }
    const state = await this.d.candidates.candidate(item, contract);
    const runs = await this.checkRuns(item, contract);
    const stale = this.staleChecks(contract, state, runs);
    if (!stale.length) return { action: "advance" };
    const gaps = stale.map((id) => `${id} lacks passing readiness evidence for the current candidate`);
    // After the review step has run, or past the barrier stage, stale evidence means the reviewed candidate drifted.
    if (stage.name !== policy.barrierStage || (item.status?.step ?? 0) > 0) {
      return this.retry(item, "candidate-drift", contract.policy.maxExecutionAttempts, policy.barrierStage,
        `The candidate changed after its completeness barrier (${gaps.join("; ")}). Inspect what modified the workspace, then explicitly restart ${policy.barrierStage}.`);
    }
    const barrierRuns = runs.filter((r) => r.spec.workflow?.unit === BARRIER_UNIT && (active(r) || this.fresh(contract, state, r)));
    for (const id of stale) {
      const decision = await this.readiness(item, contract, state, id, barrierRuns, { stage: stage.name, unit: BARRIER_UNIT }, "unit-repair");
      if (decision) return decision;
    }
    return { action: "wait", retryAfterMs: 1000 };
  }

  async assertComplete(item: WorkItem, contract: ValidationContract): Promise<void> {
    const ledger = await this.ledger(item, contract);
    const gaps = this.gaps(contract, await this.d.candidates.candidate(item, contract), ledger, await this.checkRuns(item, contract));
    if (gaps.length) invalid(`approved Units are incomplete for this candidate: ${gaps.join("; ")}`);
  }

  async progress(_p: Principal, name: string): Promise<UnitProgressView> {
    const item = await this.d.reader.get<WorkItem>("WorkItem", this.d.namespace, name);
    if (!item) throw new StoreError("work item not found", "NotFound");
    return this.view(item);
  }

  async view(item: WorkItem): Promise<UnitProgressView> {
    if (!item.spec.workflowRef || !(await this.d.compiler.compile(item.spec.workflowRef, nsOf(item))).unitExecution) return { enabled: false, units: [] };
    let contract: ValidationContract;
    try { contract = await this.d.contracts.plan(item, true); }
    catch (e) {
      if (!isStoreError(e, "Invalid")) throw e;
      return { enabled: true, units: [], error: this.d.redactor.redact(e.message) };
    }
    const ledger = await this.ledger(item, contract);
    const attempts = await this.attempts(item, contract);
    const checks = await this.checkRuns(item, contract);
    const current = item.status?.stage === contract.policy.implementationStage
      ? attempts.find((r) => roundOf(r.metadata.name) === item.status?.round)?.spec.assignment : undefined;
    const units: UnitProgress[] = ledger.map((e) => {
      const assigned = current?.kind === "unit" && current.unit === e.unit.id;
      const checking = assigned && checks.some((c) => active(c) && c.spec.workflow?.unit === e.unit.id);
      const state = e.ready ? "ready" : assigned && item.status?.phase === "Blocked" ? "blocked" : checking ? "checking" : assigned ? "implementing" : "pending";
      return { unit: e.unit, state, checks: e.checks, diagnostics: e.diagnostics.map((d) => this.d.redactor.redact(d)),
        attempt: e.run && { run: e.run.metadata.name, outcome: e.run.status?.result?.outcome, summary: e.run.status?.result?.summary && this.d.redactor.redact(e.run.status.result.summary) } };
    });
    let barrier: UnitProgressView["barrier"];
    if (ledger.every((e) => e.ready)) {
      try {
        const missing = this.gaps(contract, await this.d.candidates.candidate(item, contract), ledger, checks);
        barrier = { satisfied: !missing.length, missing };
      } catch (e) {
        if (!isStoreError(e, "Invalid")) throw e;
        barrier = { satisfied: false, missing: [this.d.redactor.redact(e.message)] };
      }
    } else barrier = { satisfied: false, missing: ledger.filter((e) => !e.ready).map((e) => `Unit ${e.unit.id} not ready`) };
    return { enabled: true, planFingerprint: contract.fingerprint, current, units, barrier };
  }
}
