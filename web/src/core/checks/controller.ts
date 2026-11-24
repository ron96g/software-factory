import type { AgentRun, CheckFinding, CheckOutcome, CheckRun, CheckTestResults, CheckWorkflowOrigin, Repository, WorkItem, Workflow, Workspace } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { keyOf, nsOf, parseKey, setCondition } from "../model/meta.ts";
import { DEFAULT_NAMESPACE } from "../model/resource.ts";
import { exitCodeClassifier } from "./classifiers.ts";
import { SandboxUnavailableError, isStoreError, type CheckResultClassifier, type FindingExtractor, type CheckExecutionRunner, type Clock, type Controller, type EventRecorder, type ExecResult, type FencedStatusWriter, type InitialKeys, type CandidateChanges, type TestResultExtractor, type LeaseRef, type Lookup, type ModuleScopePlanner, type RecoveryCheckAuthorization, type Redactor, type ResourceReader, type StatusWriter, type TranscriptWriter, type VerificationContracts, type WorkspaceLock, type WorkspaceSnapshotter } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { rerunCheckConfig, rerunOriginal, resolveCheckConfig } from "./config.ts";
import { ORIGIN_KEYS, ORIGIN_PURPOSES, gateBaseline, originAuthorized, originChecks, validCallerName, validUnitFields } from "./origin.ts";
import { checkDefinitionVersion } from "./definition-version.ts";
import { testId } from "../model/tests.ts";
import { isAbsolute, relative } from "node:path";

export interface CheckControllerDeps {
  reader: ResourceReader;
  status: StatusWriter;
  logs: TranscriptWriter;
  runner: CheckExecutionRunner;
  snapshots: WorkspaceSnapshotter;
  clock: Clock;
  events: EventRecorder;
  redactor: Redactor;
  onError: (message: string) => void;
  /** ADR-0062: the CheckRun execution lease (claim/renew/release) and its fenced status writer. */
  claims: WorkspaceLock;
  fenced: FencedStatusWriter;
  /** This process's identity for the lease (diagnostics, not a credential). */
  holder: string;
  /** ADR-0062 §3: when this process loaded its definitions, so it can tell "worker is older" from "the check is stale". */
  definitionsLoadedAt?: string;
  /** ADR-0062 §3: live-lease concurrency limits across workers (defaults: 1 per workspace, 2 total). */
  maxPerWorkspace?: number;
  maxTotal?: number;
  classifiers?: Lookup<CheckResultClassifier>;
  contracts?: VerificationContracts;
  scopes?: ModuleScopePlanner;
  recoveryChecks?: RecoveryCheckAuthorization;
  /** ADR-0086: marks failed tests whose file the candidate changed. Without it, no failure counts as untouched. */
  changes?: CandidateChanges;
}

const MAX_FAILED_TESTS = 200;
const OUTPUT_TAIL = 2000;

type CheckContext = { item: WorkItem; workspace: Workspace; repository: Repository };

const activePhase = (run: AgentRun) => ["Running", "Pending"].includes(run.status?.phase ?? "Pending");
const stopped = (item: WorkItem) => ["Failed", "Done", "Closed"].includes(item.status?.phase ?? "") &&
  (!item.spec.restart || item.spec.restart.id === item.status?.restartHandled);
const restartPending = (item: WorkItem) => !!item.spec.restart && item.spec.restart.id !== item.status?.restartHandled;

function isOwnedBy(item: WorkItem, candidate: { metadata: { namespace?: string; ownerReferences?: { kind: string; name: string; uid: string }[] } }): boolean {
  const owners = candidate.metadata.ownerReferences ?? [];
  return (candidate.metadata.namespace ?? DEFAULT_NAMESPACE) === nsOf(item) && owners.length === 1 &&
    owners[0].kind === "WorkItem" && owners[0].name === item.metadata.name && owners[0].uid === item.metadata.uid;
}

/** ADR-0062 §2: the CheckRun execution lease key (per WorkItem, so per-workspace concurrency can be counted). */
const claimKey = (namespace: string, workItemUid: string, name: string): string => `checkrun/${namespace}/${workItemUid}/${name}`;

/** The lease TTL covers the check's own budget plus a margin. */
const claimTtlMs = (run: CheckRun): number => (run.spec.timeoutMs ?? 15 * 60_000) + 60_000;

function validWorkflowOrigin(origin: CheckWorkflowOrigin | undefined): origin is CheckWorkflowOrigin {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const keys = Object.keys(origin).sort();
  return keys.every((key) => ORIGIN_KEYS.has(key)) && validUnitFields(origin) &&
    typeof origin.stage === "string" && !!origin.stage.trim() &&
    Number.isSafeInteger(origin.round) && origin.round >= 0 &&
    Number.isSafeInteger(origin.attempt) && origin.attempt >= 1 &&
    ORIGIN_PURPOSES.includes(origin.purpose) &&
    (origin.purpose !== "preparation" || origin.agentRunRef === undefined) &&
    typeof origin.planFingerprint === "string" && !!origin.planFingerprint.trim() && origin.planFingerprint.length <= 256 &&
    (origin.agentRequestId === undefined ||
      typeof origin.agentRequestId === "string" && !!origin.agentRequestId.trim() && origin.agentRequestId.length <= 200) &&
    (origin.agentRunRef === undefined || (
      origin.agentRunRef !== null &&
      typeof origin.agentRunRef === "object" && !Array.isArray(origin.agentRunRef) &&
      Object.keys(origin.agentRunRef).every((key) => key === "name" || key === "namespace") &&
      typeof origin.agentRunRef.name === "string" && !!origin.agentRunRef.name.trim() &&
      (origin.agentRunRef.namespace === undefined ||
        typeof origin.agentRunRef.namespace === "string" && !!origin.agentRunRef.namespace.trim()) &&
      typeof origin.agentRunUid === "string" && !!origin.agentRunUid.trim()
    )) &&
    (origin.agentRunRef !== undefined || origin.agentRunUid === undefined && origin.agentRequestId === undefined);
}

function configuredForOrigin(repository: Repository, origin: CheckWorkflowOrigin, check: string, workflow: Workflow | null): boolean {
  return !!originChecks(repository, origin, workflow)?.includes(check);
}

export function createCheckRunController(d: CheckControllerDeps): Controller & InitialKeys & { stop(): Promise<void> } {
  const jobs = new Map<string, Promise<void>>();
  const activeItems = new Set<string>();

  function classifier(format: string): CheckResultClassifier | undefined {
    return d.classifiers?.get(format) ?? (format === exitCodeClassifier.format ? exitCodeClassifier : undefined);
  }

  async function loadContext(run: CheckRun): Promise<{ context?: CheckContext; reason?: string; workerOlder?: boolean }> {
    const namespace = nsOf(run);
    if (!run.spec?.workItemRef?.name || !run.spec.workItemUid ||
        !run.spec.workspaceRef?.name || !run.spec.workspaceUid ||
        !run.spec.repositoryRef?.name || !run.spec.repositoryVersion ||
        !run.spec.check || !run.spec.command || !run.spec.snapshot) {
      return { reason: "CheckRun spec is incomplete" };
    }
    const item = await d.reader.get<WorkItem>("WorkItem", namespace, run.spec.workItemRef.name);
    if (!item || item.metadata.uid !== run.spec.workItemUid ||
        run.spec.workItemRef.namespace && run.spec.workItemRef.namespace !== namespace ||
        !isOwnedBy(item, run)) {
      return { reason: "check ownership or work item identity is invalid" };
    }

    if (restartPending(item)) return { reason: "work item has an unhandled restart" };
    const workflowOrigin = run.spec.workflow;
    let workflow: Workflow | null = null;
    if (workflowOrigin) {
      if (!validWorkflowOrigin(workflowOrigin) ||
          !["Running", "Waiting"].includes(item.status?.phase ?? "") ||
          item.status?.stage !== workflowOrigin.stage || item.status?.round !== workflowOrigin.round) {
        return { reason: "workflow check is stale or does not match the current item stage and round" };
      }
      workflow = item.spec.workflowRef
        ? await resolveRef<Workflow>(d.reader, "Workflow", item.spec.workflowRef, namespace)
        : null;
      if (!originAuthorized(workflow, workflowOrigin)) {
        return { reason: "workflow check origin is not authorized by the current verification policy" };
      }
    } else if (!stopped(item)) {
      return { reason: "standalone checks require a stopped work item" };
    }

    const workspace = await d.reader.get<Workspace>("Workspace", namespace, run.spec.workspaceRef.name);
    if (!workspace || workspace.metadata.uid !== run.spec.workspaceUid ||
        workspace.status?.phase !== "Ready" || !workspace.status.path ||
        workspace.spec.workItemRef.name !== item.metadata.name || !isOwnedBy(item, workspace) ||
        run.spec.workspaceRef.namespace && run.spec.workspaceRef.namespace !== namespace) {
      return { reason: "workspace identity, ownership or readiness changed" };
    }
    const repository = await resolveRef<Repository>(d.reader, "Repository", run.spec.repositoryRef, namespace);
    if (!repository || repository.metadata.name !== workspace.spec.repositoryRef.name) {
      return { reason: "repository identity changed" };
    }
    if (checkDefinitionVersion(repository) !== run.spec.repositoryVersion) {
      // ADR-0062 §3: a worker whose loaded definitions predate the run's pinned version leaves it Pending for a restart;
      // a run whose pinned definition is stale (the worker is newer) ends as not executed, as before.
      const workerOlder = !!d.definitionsLoadedAt && !!run.metadata.creationTimestamp && d.definitionsLoadedAt < run.metadata.creationTimestamp;
      return workerOlder
        ? { reason: "worker definitions are older than the check's pinned definition; restart the worker", workerOlder: true }
        : { reason: "repository definition changed since check submission" };
    }
    let config: Awaited<ReturnType<typeof resolveCheckConfig>>;
    try {
      if (run.spec.workflow?.purpose === "rerun-failed") {
        const original = await rerunOriginal(d.reader, item, workspace, run.spec.check, run.spec.workflow);
        if (original.spec.snapshot !== run.spec.snapshot) return { reason: "a targeted re-run needs the original attempt's snapshot" };
        config = rerunCheckConfig(repository, run.spec.check, original);
      } else config = await resolveCheckConfig(repository, run.spec.check, workspace, d.scopes, run.spec.workflow?.purpose);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : "check configuration is invalid" };
    }
    if (config.command !== run.spec.command || config.timeoutMs !== run.spec.timeoutMs ||
        config.resultFormat !== run.spec.resultFormat || JSON.stringify(config.scope) !== JSON.stringify(run.spec.scope)) {
      return { reason: "repository command, budget, scope or result format differs from the submitted check" };
    }
    if (d.redactor.redact(config.command) !== config.command) return { reason: "configured command contains a factory secret" };
    if (workflowOrigin && !configuredForOrigin(repository, workflowOrigin, run.spec.check, workflow)) {
      return { reason: `check "${run.spec.check}" is not authorized for ${workflowOrigin.purpose}` };
    }
    if (workflowOrigin && (workflowOrigin.purpose === "diagnostic" || workflowOrigin.purpose === "baseline" ||
        workflowOrigin.purpose === "unit-readiness" && workflowOrigin.agentRunRef) && !gateBaseline(workflowOrigin)) {
      if (!d.recoveryChecks || !workflowOrigin.agentRunRef) return { reason: "scoped recovery authorization is unavailable" };
      const caller = await d.reader.get<AgentRun>("AgentRun", namespace, workflowOrigin.agentRunRef.name);
      if (!caller) return { reason: "recovery check caller not found" };
      try { await d.recoveryChecks.authorize({ item, origin: workflowOrigin, repository, workspace, check: run.spec.check, caller, existing: run }); }
      catch (error) { return { reason: error instanceof Error ? error.message : "recovery check authorization failed" }; }
    }
    if (workflowOrigin && d.contracts) {
      try {
        const contract = await d.contracts.plan(item, true);
        const checks = workflowOrigin.purpose === "preflight" ? contract.plan.preflight : contract.plan.checks;
        if (contract.fingerprint !== workflowOrigin.planFingerprint ||
            workflowOrigin.purpose !== "diagnostic" && workflowOrigin.purpose !== "baseline" && !checks.includes(`${repository.metadata.name}/${run.spec.check}`)) {
          return { reason: "check is outside the current human-approved verification plan" };
        }
      } catch (error) {
        if (!isStoreError(error, "Invalid")) throw error;
        return { reason: error.message };
      }
    }
    if (workflowOrigin && !classifier(run.spec.resultFormat ?? exitCodeClassifier.format)) {
      return { reason: `no classifier is registered for result format "${run.spec.resultFormat}"` };
    }
    return { context: { item, workspace, repository } };
  }

  async function validateAgents(item: WorkItem, origin: CheckWorkflowOrigin | undefined): Promise<string | undefined> {
    const namespace = nsOf(item);
    const agents = await d.reader.list<AgentRun>("AgentRun", {
      namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
    });
    const active = agents.filter(activePhase);
    if (!origin?.agentRunRef) {
      if (active.length) return "work item has active agent runs";
      return undefined;
    }
    const ref = origin.agentRunRef;
    if (ref.namespace && ref.namespace !== namespace) return "workflow caller is outside the work item namespace";
    const caller = active.find((run) => run.metadata.name === ref.name);
    if (!caller || caller.status?.phase !== "Running" || caller.metadata.uid !== origin.agentRunUid || caller.spec.stage !== origin.stage ||
        caller.spec.workItemRef.name !== item.metadata.name || caller.spec.replayOf ||
    caller.spec.workItemRef.namespace && caller.spec.workItemRef.namespace !== namespace ||
    caller.metadata.labels?.[LABEL_SUPERSEDED] !== undefined ||
        caller.metadata.labels?.["factory.ai-dlc.io/stage"] !== origin.stage ||
        caller.metadata.labels?.["factory.ai-dlc.io/workitem"] !== item.metadata.name ||
        !validCallerName(item, origin, caller) ||
        !isOwnedBy(item, caller)) {
      return "workflow caller is not an active, current-round AgentRun";
    }
    if (active.some((run) => run.metadata.name !== caller.metadata.name)) return "another agent run is active for this work item";
    return undefined;
  }

  async function activeCheckConflict(run: CheckRun): Promise<boolean> {
    const namespace = nsOf(run);
    const runs = await d.reader.list<CheckRun>("CheckRun", {
      namespace, ownedBy: { kind: "WorkItem", name: run.spec.workItemRef.name, namespace },
    });
    const active = runs.filter((candidate) => candidate.metadata.uid !== run.metadata.uid &&
      candidate.spec.workItemUid === run.spec.workItemUid &&
      (!candidate.status || candidate.status.phase === "Running"));
    return active.some((candidate) => candidate.status?.phase === "Running" ||
      candidate.metadata.name.localeCompare(run.metadata.name) < 0);
  }

  async function finishWithoutRun(run: CheckRun, reason: string): Promise<void> {
    const namespace = nsOf(run);
    const logRef = run.status?.logRef ?? await d.logs.open(namespace, { kind: "CheckRun", name: run.metadata.name });
    await d.logs.append(logRef, {
      role: "note",
      author: { type: "system", id: "check-runner" },
      content: d.redactor.redact(reason),
    });
    const current = await d.reader.get<CheckRun>("CheckRun", namespace, run.metadata.name);
    if (!current) return;
    const now = d.clock.now();
    const completed = await d.status.updateStatus<CheckRun>({
      ...current,
      status: {
        ...current.status,
        phase: "Completed",
        outcome: "NotVerified",
        message: d.redactor.redact(reason),
        finishedAt: now.toISOString(),
        logRef,
        logsIncomplete: false,
        conditions: setCondition(current.status?.conditions, "Verified", "False", "NotVerified", d.redactor.redact(reason), now),
      },
    });
    await d.events.warning(completed, "CheckNotVerified", completed.status!.message!);
  }

  async function markInterrupted(run: CheckRun): Promise<void> {
    const current = await d.reader.get<CheckRun>("CheckRun", nsOf(run), run.metadata.name);
    if (!current || current.status?.phase !== "Running") return;
    const now = d.clock.now();
    const interrupted = await d.status.updateStatus<CheckRun>({
      ...current,
      status: {
        ...current.status,
        phase: "Interrupted",
        outcome: "Cancelled",
        logsIncomplete: true,
        finishedAt: now.toISOString(),
        message: "execution interrupted; a new explicit request is required to rerun",
        conditions: setCondition(current.status.conditions, "Verified", "False", "Interrupted", "execution interrupted", now),
      },
    });
    await d.events.warning(interrupted, "CheckInterrupted", interrupted.status!.message!);
  }

  /** ADR-0086: names must survive redaction unchanged; files become workspace-relative and are marked when the candidate changed them. */
  async function testResults(workspace: Workspace, raw: ReturnType<TestResultExtractor["testResults"]>): Promise<CheckTestResults | undefined> {
    if (!raw || raw.failed.length > MAX_FAILED_TESTS || raw.failed.some((t) => d.redactor.redact(t.name) !== t.name)) return undefined;
    const root = workspace.status?.path;
    const local = (file?: string) => {
      if (!file || !root) return undefined;
      const path = relative(root, file.replace(/^file:\/\//, ""));
      return path && !path.startsWith("..") && !isAbsolute(path) ? path : undefined;
    };
    const failed: CheckTestResults["failed"] = raw.failed.map((t) => ({ name: t.name, ...(local(t.file) ? { file: local(t.file) } : {}) }));
    if (failed.some((t) => t.file) && d.changes) {
      try {
        const changed = new Set(await d.changes.changedFiles(workspace));
        for (const t of failed) if (t.file) t.touched = changed.has(t.file);
      } catch {
        // Unknown changes: no failure can be shown to be untouched (ADR-0086 §2).
      }
    }
    return { failed, passed: [...new Set(raw.passed.map(testId))].sort(), skipped: raw.skipped };
  }

  async function execute(run: CheckRun, lease: LeaseRef): Promise<void> {
    const namespace = nsOf(run);
    const eligibility = await loadContext(run);
    if (!eligibility.context) {
      await finishWithoutRun(run, eligibility.reason ?? "check is no longer eligible");
      return;
    }
    const { item, workspace, repository } = eligibility.context;
    const agentError = await validateAgents(item, run.spec.workflow);
    if (agentError) {
      await finishWithoutRun(run, agentError);
      return;
    }
    if (await activeCheckConflict(run)) {
      await finishWithoutRun(run, "another check became active for this work item");
      return;
    }
    if (await d.snapshots.fingerprint(workspace) !== run.spec.snapshot) {
      await finishWithoutRun(run, "workspace changed since check submission");
      return;
    }

    let result: ExecResult | undefined;
    let outcome: CheckOutcome = "UnknownFailure";
    let executionOutcome: CheckOutcome | undefined;
    let message = "";
    let outputLogged = false;
    let finalSnapshot: string | undefined;
    let failureEvidence: { tests: string[] } | undefined;
    let findings: CheckFinding[] | undefined;
    let tests: CheckTestResults | undefined;
    // ADR-0062 §2: keep the execution lease alive while a long check runs; a lost lease stops the result from being written.
    const ttlMs = claimTtlMs(run);
    const renew = setInterval(() => {
      void d.claims.renew(lease.key, lease.holder, lease.generation, ttlMs).then((ok) => {
        if (!ok) d.onError(`check ${namespace}/${run.metadata.name}: execution lease lost; the result will not be written`);
      });
    }, Math.max(1000, Math.floor(ttlMs / 4)));
    try {
      result = await d.runner.execute(run, workspace, repository);
      await d.logs.append(run.status!.logRef!, {
        role: "tool-result",
        author: { type: "system", id: "check-runner" },
        content: d.redactor.redact(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`),
        meta: { tool: run.spec.check, truncated: result.truncated, termination: result.termination },
      });
      outputLogged = true;
      try {
        finalSnapshot = await d.snapshots.fingerprint(workspace);
      } catch (error) {
        outcome = "NotVerified";
        message = `could not verify the resulting workspace snapshot: ${d.redactor.redact(error instanceof Error ? error.message : String(error))}`;
      }
      if (!message) {
        const format = run.spec.resultFormat ?? exitCodeClassifier.format;
        const selectedClassifier = classifier(format);
        if (!selectedClassifier) {
          outcome = "NotVerified";
          message = `no classifier is registered for result format "${format}"`;
        } else if (result.termination?.kind === "timeout") outcome = "TimedOut";
        else if (result.termination?.kind === "signal") outcome = "Cancelled";
        else if (result.termination?.kind === "spawn-error") outcome = "Unavailable";
        else if (run.spec.workflow?.purpose === "preflight" && result.exitCode !== 0) outcome = "SetupFailed";
        else {
          outcome = selectedClassifier.classify(result);
          if (outcome === "FindingsReported" && finalSnapshot === run.spec.snapshot && "extractFindings" in selectedClassifier) {
            const extracted = (selectedClassifier as FindingExtractor).extractFindings(result);
            if (extracted && extracted.every((f) => d.redactor.redact(f.id) === f.id)) findings = extracted;
            else outcome = "UnknownFailure";
          }
          if (outcome === "AssertionFailed" && finalSnapshot === run.spec.snapshot) {
            const evidence = selectedClassifier.failureEvidence?.(result);
            if (evidence && evidence.tests.every((name) => d.redactor.redact(name) === name)) failureEvidence = evidence;
          }
          if ((outcome === "Passed" || outcome === "AssertionFailed") && finalSnapshot === run.spec.snapshot && "testResults" in selectedClassifier) {
            tests = await testResults(workspace, (selectedClassifier as TestResultExtractor).testResults(result));
          }
        }
        message = `${run.spec.check}: ${outcome} (exit ${result.exitCode} in ${result.durationMs} ms)`;
      }
      executionOutcome = outcome;
      if (outcome === "Passed" && finalSnapshot !== run.spec.snapshot) {
        outcome = "NotVerified";
        message += "; check changed the candidate workspace";
      }
      if (executionOutcome === "Passed" || failureEvidence) {
        const after = await loadContext(run);
        const afterAgentError = after.context ? await validateAgents(after.context.item, run.spec.workflow) : after.reason;
        if (afterAgentError) {
          outcome = "NotVerified";
          executionOutcome = undefined;
          failureEvidence = undefined;
          tests = undefined;
          message += `; workflow origin changed during execution: ${afterAgentError}`;
        }
      }
    } catch (error) {
      outcome = error instanceof SandboxUnavailableError ? "Unavailable" : "UnknownFailure";
      message = d.redactor.redact(error instanceof Error ? error.message : String(error));
      await d.logs.append(run.status!.logRef!, {
        role: "note",
        author: { type: "system", id: "check-runner" },
        content: message,
      });
    } finally {
      clearInterval(renew);
    }

    const current = await d.reader.get<CheckRun>("CheckRun", namespace, run.metadata.name);
    if (!current) return;
    const now = d.clock.now();
    const done = await d.fenced.updateStatusIf<CheckRun>({
      ...current,
      status: {
        ...current.status!,
        phase: "Completed",
        outcome,
        executionOutcome,
        failureEvidence,
        findings,
        tests,
        outputTail: outcome !== "Passed" && result ? d.redactor.redact(`${result.stdout}\n${result.stderr}`.trim()).slice(-OUTPUT_TAIL) || undefined : undefined,
        message: d.redactor.redact(message),
        finishedAt: now.toISOString(),
        exitCode: result?.exitCode,
        signal: result?.termination?.signal,
        durationMs: result?.durationMs,
        logsIncomplete: !result || result.truncated || !outputLogged ||
          result.termination?.kind === "timeout" || result.termination?.kind === "signal" ||
          result.termination?.kind === "spawn-error",
        finalSnapshot,
        // ADR-0086: a targeted re-run covers only some tests, so it never verifies the check, even when it passes.
        conditions: setCondition(current.status?.conditions, "Verified", outcome === "Passed" && run.spec.workflow?.purpose !== "rerun-failed" ? "True" : "False",
          run.spec.workflow?.purpose === "rerun-failed" ? `Rerun${outcome}` : outcome, d.redactor.redact(message), now),
      },
    }, lease);
    // A lost lease (expired or taken over) means another holder owns the result now (ADR-0062 §2): never write over it.
    if (!done) return;
    if (run.spec.workflow?.purpose === "rerun-failed") await d.events.normal(done, "RerunCompleted", `targeted re-run of ${run.spec.workflow.rerunOf}: ${done.status!.message}`);
    else if (outcome === "Passed") await d.events.normal(done, "CheckCompleted", done.status!.message!);
    else await d.events.warning(done, "CheckCompleted", `${outcome}: ${done.status!.message}`);
  }

  return {
    name: "checkrun",
    primaryKind: "CheckRun",
    watches: ["CheckRun"],
    resyncMs: 2000,
    keysFor: (event) => [keyOf(event.object)],
    initialKeys: async () => (await d.reader.list<CheckRun>("CheckRun"))
      .filter((run) => !run.status || run.status.phase === "Running")
      .map(keyOf),
    async reconcile(key) {
      if (jobs.has(key)) return { requeueAfterMs: 1000 };
      const { namespace, name } = parseKey(key);
      const run = await d.reader.get<CheckRun>("CheckRun", namespace, name);
      if (!run || run.status && run.status.phase !== "Running") return;
      try {
        if (run.status?.phase === "Running") {
          // ADR-0062 §2: a live lease means another holder is executing it; only an expired/absent lease is stale.
          if (await d.claims.get(claimKey(namespace, run.spec.workItemUid, name))) return { requeueAfterMs: 1000 };
          const item = await d.reader.get<WorkItem>("WorkItem", namespace, run.spec.workItemRef.name);
          if (!item || !isOwnedBy(item, run) || item.metadata.uid !== run.spec.workItemUid) {
            await finishWithoutRun(run, "check ownership or work item identity is invalid");
            return;
          }
          await markInterrupted(run);
          return;
        }

        const eligibility = await loadContext(run);
        if (!eligibility.context) {
          // ADR-0062 §3: a worker whose definitions are older waits for a restart instead of ending the run.
          if (eligibility.workerOlder) return { requeueAfterMs: 5000 };
          await finishWithoutRun(run, eligibility.reason ?? "check is no longer eligible");
          return;
        }
        const { item } = eligibility.context;
        const agentError = await validateAgents(item, run.spec.workflow);
        if (agentError) {
          await finishWithoutRun(run, agentError);
          return;
        }
        if (await activeCheckConflict(run)) return { requeueAfterMs: 1000 };

        const itemKey = `${namespace}/${item.metadata.uid}`;
        if (activeItems.has(itemKey)) return { requeueAfterMs: 1000 };
        // ADR-0062 §3: bounded concurrency, counted from live leases so the limits hold across workers.
        const live = await d.claims.list("checkrun/");
        const perWorkspace = live.filter((l) => l.key.startsWith(`checkrun/${namespace}/${item.metadata.uid}/`)).length;
        if (live.length >= (d.maxTotal ?? 2) || perWorkspace >= (d.maxPerWorkspace ?? 1)) return { requeueAfterMs: 1000 };
        // ADR-0062 §2: claim the execution lease before running; another holder (another process) means we skip it.
        const leaseKey = claimKey(namespace, item.metadata.uid!, name);
        const lease = await d.claims.acquire(leaseKey, d.holder, claimTtlMs(run));
        if (!lease) return { requeueAfterMs: 1000 };
        const leaseRef: LeaseRef = { key: leaseKey, holder: lease.holder, generation: lease.generation };
        activeItems.add(itemKey);
        try {
          const logRef = await d.logs.open(namespace, { kind: "CheckRun", name });
          const latest = await d.reader.get<CheckRun>("CheckRun", namespace, name);
          if (!latest || latest.status) return;
          const now = d.clock.now();
          const started = await d.status.updateStatus<CheckRun>({
            ...latest,
            status: {
              phase: "Running",
              startedAt: now.toISOString(),
              logRef,
              conditions: setCondition(undefined, "Verified", "Unknown", "Running", undefined, now),
            },
          });
          const job = execute(started, leaseRef)
            .catch((error: unknown) => d.onError(d.redactor.redact(error instanceof Error ? error.message : String(error))))
            .finally(() => {
              jobs.delete(key);
              activeItems.delete(itemKey);
              void d.claims.release(leaseRef.key, leaseRef.holder, leaseRef.generation);
            });
          jobs.set(key, job);
          void d.events.normal(started, "CheckStarted", `${started.spec.check} execution started`)
            .catch((error: unknown) => d.onError(d.redactor.redact(error instanceof Error ? error.message : String(error))));
          return { requeueAfterMs: 1000 };
        } finally {
          if (!jobs.has(key)) {
            activeItems.delete(itemKey);
            await d.claims.release(leaseRef.key, leaseRef.holder, leaseRef.generation);
          }
        }
      } catch (error) {
        if (isStoreError(error, "Conflict")) return { requeueAfterMs: 0 };
        throw error;
      }
    },
    async stop() { await Promise.all(jobs.values()); },
  };
}
