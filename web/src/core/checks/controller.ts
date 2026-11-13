import type { AgentRun, CheckOutcome, CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workflow, Workspace } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { keyOf, nsOf, parseKey, setCondition } from "../model/meta.ts";
import { DEFAULT_NAMESPACE } from "../model/resource.ts";
import { exitCodeClassifier } from "./classifiers.ts";
import { SandboxUnavailableError, isStoreError, type CheckResultClassifier, type CheckExecutionRunner, type Clock, type Controller, type EventRecorder, type ExecResult, type InitialKeys, type Lookup, type Redactor, type ResourceReader, type StatusWriter, type TranscriptWriter, type VerificationContracts, type WorkspaceSnapshotter } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { checkConfig } from "./config.ts";

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
  classifiers?: Lookup<CheckResultClassifier>;
  contracts?: VerificationContracts;
}

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

function validWorkflowOrigin(origin: CheckWorkflowOrigin | undefined): origin is CheckWorkflowOrigin {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const keys = Object.keys(origin).sort();
  const allowed = new Set(["agentRequestId", "agentRunRef", "agentRunUid", "attempt", "planFingerprint", "purpose", "round", "stage"]);
  return keys.every((key) => allowed.has(key)) &&
    typeof origin.stage === "string" && !!origin.stage.trim() &&
    Number.isSafeInteger(origin.round) && origin.round >= 0 &&
    Number.isSafeInteger(origin.attempt) && origin.attempt >= 1 &&
    ["preflight", "preparation", "verification"].includes(origin.purpose) &&
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

function configuredForOrigin(repository: Repository, origin: CheckWorkflowOrigin, check: string): boolean {
  const allowed = origin.purpose === "preflight"
    ? repository.spec.verification?.preflightChecks
    : origin.purpose === "preparation" ? repository.spec.verification?.preparationChecks
    : Object.keys(repository.spec.checks ?? {});
  return !!allowed?.includes(check);
}

export function createCheckRunController(d: CheckControllerDeps): Controller & InitialKeys & { stop(): Promise<void> } {
  const jobs = new Map<string, Promise<void>>();
  const activeItems = new Set<string>();

  function classifier(format: string): CheckResultClassifier | undefined {
    return d.classifiers?.get(format) ?? (format === exitCodeClassifier.format ? exitCodeClassifier : undefined);
  }

  async function loadContext(run: CheckRun): Promise<{ context?: CheckContext; reason?: string }> {
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
    if (workflowOrigin) {
      if (!validWorkflowOrigin(workflowOrigin) ||
          !["Running", "Waiting"].includes(item.status?.phase ?? "") ||
          item.status?.stage !== workflowOrigin.stage || item.status?.round !== workflowOrigin.round) {
        return { reason: "workflow check is stale or does not match the current item stage and round" };
      }
      const workflow = item.spec.workflowRef
        ? await resolveRef<Workflow>(d.reader, "Workflow", item.spec.workflowRef, namespace)
        : null;
      const policy = workflow?.spec.verification;
      if (!workflow || !policy ||
          (workflowOrigin.purpose === "preflight" ? policy.preflightStage :
            workflowOrigin.purpose === "preparation" ? policy.preparationStage : policy.verifyStage) !== workflowOrigin.stage) {
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
    if (!repository || repository.metadata.name !== workspace.spec.repositoryRef.name ||
        repository.metadata.resourceVersion !== run.spec.repositoryVersion) {
      return { reason: "repository identity or definition changed" };
    }
    let config: ReturnType<typeof checkConfig>;
    try {
      config = checkConfig(repository, run.spec.check);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : "check configuration is invalid" };
    }
    if (config.command !== run.spec.command || config.timeoutMs !== run.spec.timeoutMs ||
        config.resultFormat !== run.spec.resultFormat) {
      return { reason: "repository command, budget or result format differs from the submitted check" };
    }
    if (d.redactor.redact(config.command) !== config.command) return { reason: "configured command contains a factory secret" };
    if (workflowOrigin && !configuredForOrigin(repository, workflowOrigin, run.spec.check)) {
      return { reason: `check "${run.spec.check}" is not authorized for ${workflowOrigin.purpose}` };
    }
    if (workflowOrigin && d.contracts) {
      try {
        const contract = await d.contracts.plan(item, true);
        const checks = workflowOrigin.purpose === "preflight" ? contract.plan.preflight : contract.plan.checks;
        if (contract.fingerprint !== workflowOrigin.planFingerprint || !checks.includes(`${repository.metadata.name}/${run.spec.check}`)) {
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
        !caller.metadata.name.startsWith(`${item.metadata.name}-${origin.stage}-`) ||
        !caller.metadata.name.endsWith(`-r${origin.round}`) ||
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

  async function execute(run: CheckRun): Promise<void> {
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
        else outcome = selectedClassifier.classify(result);
        message = `${run.spec.check}: ${outcome} (exit ${result.exitCode} in ${result.durationMs} ms)`;
      }
      executionOutcome = outcome;
      if (outcome === "Passed" && finalSnapshot !== run.spec.snapshot) {
        outcome = "NotVerified";
        message += "; check changed the candidate workspace";
      }
      if (executionOutcome === "Passed") {
        const after = await loadContext(run);
        const afterAgentError = after.context ? await validateAgents(after.context.item, run.spec.workflow) : after.reason;
        if (afterAgentError) {
          outcome = "NotVerified";
          executionOutcome = undefined;
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
    }

    const current = await d.reader.get<CheckRun>("CheckRun", namespace, run.metadata.name);
    if (!current) return;
    const now = d.clock.now();
    const done = await d.status.updateStatus<CheckRun>({
      ...current,
      status: {
        ...current.status!,
        phase: "Completed",
        outcome,
        executionOutcome,
        message: d.redactor.redact(message),
        finishedAt: now.toISOString(),
        exitCode: result?.exitCode,
        signal: result?.termination?.signal,
        durationMs: result?.durationMs,
        logsIncomplete: !result || result.truncated || !outputLogged ||
          result.termination?.kind === "timeout" || result.termination?.kind === "signal" ||
          result.termination?.kind === "spawn-error",
        finalSnapshot,
        conditions: setCondition(current.status?.conditions, "Verified", outcome === "Passed" ? "True" : "False", outcome, d.redactor.redact(message), now),
      },
    });
    if (outcome === "Passed") await d.events.normal(done, "CheckCompleted", done.status!.message!);
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
          const job = execute(started)
            .catch((error: unknown) => d.onError(d.redactor.redact(error instanceof Error ? error.message : String(error))))
            .finally(() => {
              jobs.delete(key);
              activeItems.delete(itemKey);
            });
          jobs.set(key, job);
          void d.events.normal(started, "CheckStarted", `${started.spec.check} execution started`)
            .catch((error: unknown) => d.onError(d.redactor.redact(error instanceof Error ? error.message : String(error))));
          return { requeueAfterMs: 1000 };
        } finally {
          if (!jobs.has(key)) activeItems.delete(itemKey);
        }
      } catch (error) {
        if (isStoreError(error, "Conflict")) return { requeueAfterMs: 0 };
        throw error;
      }
    },
    async stop() { await Promise.all(jobs.values()); },
  };
}
