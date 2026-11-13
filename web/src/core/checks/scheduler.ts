import { createHash } from "node:crypto";
import type { AgentRun, CheckRun, CheckWorkflowOrigin, Repository, SandboxProfile, WorkItem, Workflow, Workspace } from "../model/kinds.ts";
import { API_VERSION, DEFAULT_NAMESPACE } from "../model/resource.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import { SandboxUnavailableError, StoreError, isStoreError, type CheckRunScheduler, type ExecutionEnvironmentSelector, type Redactor, type ResourceReader, type ResourceWriter, type WorkspaceSnapshotter } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { checkConfig } from "./config.ts";

type Request = Parameters<CheckRunScheduler["submit"]>[0];

export interface CheckRunSchedulerDeps {
  reader: ResourceReader;
  writer: ResourceWriter;
  snapshots: WorkspaceSnapshotter;
  environments: ExecutionEnvironmentSelector;
  redactor: Redactor;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stoppedRestart = (item: WorkItem) => item.spec.restart && item.spec.restart.id !== item.status?.restartHandled;

function normalizeWorkflow(value: CheckWorkflowOrigin): CheckWorkflowOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("workflow origin is invalid", "Invalid");
  const keys = Object.keys(value).sort();
  const allowed = new Set(["agentRequestId", "agentRunRef", "agentRunUid", "attempt", "planFingerprint", "purpose", "round", "stage"]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new StoreError("workflow origin contains unexpected fields", "Invalid");
  }
  if (typeof value.stage !== "string" || !value.stage.trim() || value.stage.length > 200 ||
      !Number.isSafeInteger(value.round) || value.round < 0 ||
      !["preflight", "preparation", "verification"].includes(value.purpose) ||
      typeof value.planFingerprint !== "string" || !value.planFingerprint.trim() || value.planFingerprint.length > 256 ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1) {
    throw new StoreError("workflow origin is incomplete or malformed", "Invalid");
  }
  if (value.agentRequestId !== undefined &&
      (typeof value.agentRequestId !== "string" || !value.agentRequestId.trim() || value.agentRequestId.length > 200)) {
    throw new StoreError("workflow agentRequestId is malformed", "Invalid");
  }
  const hasAgentRunRef = value.agentRunRef !== undefined;
  if (value.purpose === "preparation" && hasAgentRunRef) throw new StoreError("candidate preparation cannot overlap an agent run", "Invalid");
  if (hasAgentRunRef && (typeof value.agentRunUid !== "string" || !value.agentRunUid.trim())) {
    throw new StoreError("workflow caller UID is required when agentRunRef is present", "Invalid");
  }
  if (!hasAgentRunRef && (value.agentRunUid !== undefined || value.agentRequestId !== undefined)) {
    throw new StoreError("workflow caller identity requires agentRunRef", "Invalid");
  }
  if (hasAgentRunRef && (!value.agentRunRef || typeof value.agentRunRef !== "object" || Array.isArray(value.agentRunRef) ||
      Object.keys(value.agentRunRef).some((key) => key !== "name" && key !== "namespace") ||
      typeof value.agentRunRef.name !== "string" || !value.agentRunRef.name.trim() ||
      value.agentRunRef.namespace !== undefined &&
        (typeof value.agentRunRef.namespace !== "string" || !value.agentRunRef.namespace.trim()))) {
    throw new StoreError("workflow agentRunRef is malformed", "Invalid");
  }
  return structuredClone(value);
}

function stageIsAuthorized(workflow: Workflow | null, origin: CheckWorkflowOrigin): boolean {
  const policy = workflow?.spec.verification;
  if (!policy) return false;
  return origin.purpose === "preflight"
    ? policy.preflightStage === origin.stage
    : origin.purpose === "preparation" ? policy.preparationStage === origin.stage : policy.verifyStage === origin.stage;
}

function isOwnedBy(item: WorkItem, candidate: { metadata: { namespace?: string; ownerReferences?: { kind: string; name: string; uid: string }[] } }): boolean {
  const ns = nsOf(item);
  const owners = candidate.metadata.ownerReferences ?? [];
  return (candidate.metadata.namespace ?? DEFAULT_NAMESPACE) === ns && owners.length === 1 &&
    owners[0].kind === "WorkItem" && owners[0].name === item.metadata.name && owners[0].uid === item.metadata.uid;
}

function itemMatchesOrigin(item: WorkItem, origin: CheckWorkflowOrigin): boolean {
  return ["Running", "Waiting"].includes(item.status?.phase ?? "") &&
    item.status?.stage === origin.stage && item.status?.round === origin.round && !stoppedRestart(item);
}

export class WorkflowCheckScheduler implements CheckRunScheduler {
  private readonly d: CheckRunSchedulerDeps;
  private readonly submitting = new Set<string>();

  constructor(deps: CheckRunSchedulerDeps) {
    this.d = deps;
  }

  async submit(request: Request): Promise<CheckRun> {
    const { workItem: suppliedItem, workspace: suppliedWorkspace, repository: suppliedRepository } = request;
    if (!request.requestId?.trim() || request.requestId.length > 200 || !request.requestedBy?.trim() ||
        !request.check?.trim()) {
      throw new StoreError("requestId, requestedBy and check are required", "Invalid");
    }
    const origin = normalizeWorkflow(request.workflow);
    const namespace = nsOf(suppliedItem);
    if (suppliedWorkspace.metadata.namespace && nsOf(suppliedWorkspace) !== namespace) {
      throw new StoreError("workspace must be in the work item's namespace", "Invalid");
    }
    const requestIdentity = {
      workItemUid: suppliedItem.metadata.uid,
      workspace: { name: suppliedWorkspace.metadata.name, uid: suppliedWorkspace.metadata.uid },
      check: request.check,
      requestId: request.requestId,
      requestedBy: request.requestedBy,
      workflow: origin,
    };
    const requestFingerprint = hash(requestIdentity);
    if (!suppliedItem.metadata.uid || !suppliedWorkspace.metadata.uid) {
      throw new StoreError("work item and workspace must have persisted identities", "Invalid");
    }
    const name = `check-${hash([suppliedItem.metadata.uid, request.requestId])}`;
    const lock = `${namespace}/${suppliedItem.metadata.uid}`;
    if (this.submitting.has(lock)) throw new StoreError("another workflow check submission is in progress; retry this request", "Conflict");
    this.submitting.add(lock);
    try {
      const item = await this.d.reader.get<WorkItem>("WorkItem", namespace, suppliedItem.metadata.name);
      if (!item || item.metadata.uid !== suppliedItem.metadata.uid) throw new StoreError("work item identity changed", "Conflict");
      if (!itemMatchesOrigin(item, origin)) throw new StoreError("workflow check origin is not the current active stage and round", "Conflict");
      const workflow = item.spec.workflowRef
        ? await resolveRef<Workflow>(this.d.reader, "Workflow", item.spec.workflowRef, namespace)
        : null;
      if (!stageIsAuthorized(workflow, origin)) throw new StoreError("workflow check origin is not authorized by the current verification policy", "Invalid");

      const existing = await this.d.reader.get<CheckRun>("CheckRun", namespace, name);
      if (existing) {
        if (existing.spec.requestFingerprint !== requestFingerprint || existing.spec.workItemUid !== item.metadata.uid ||
            !isOwnedBy(item, existing)) {
          throw new StoreError("check request ID was already used with different input or origin", "Conflict");
        }
        return existing;
      }

      const workspace = await this.d.reader.get<Workspace>("Workspace", namespace, suppliedWorkspace.metadata.name);
      if (!workspace || workspace.metadata.uid !== suppliedWorkspace.metadata.uid ||
          workspace.status?.phase !== "Ready" || !workspace.status.path ||
          workspace.spec.workItemRef.name !== item.metadata.name || !isOwnedBy(item, workspace)) {
        throw new StoreError("workflow check requires a Ready workspace owned by the current work item", "Invalid");
      }
      const repository = await resolveRef<Repository>(this.d.reader, "Repository", workspace.spec.repositoryRef, namespace);
      if (!repository || repository.metadata.name !== suppliedRepository.metadata.name ||
          repository.metadata.uid !== suppliedRepository.metadata.uid ||
          repository.metadata.resourceVersion !== suppliedRepository.metadata.resourceVersion) {
        throw new StoreError("repository changed or does not match the workspace", "Conflict");
      }
      if (!repository.metadata.resourceVersion) throw new StoreError("repository has no resourceVersion", "Invalid");
      const policyChecks = origin.purpose === "preflight"
        ? repository.spec.verification?.preflightChecks
        : origin.purpose === "preparation" ? repository.spec.verification?.preparationChecks
        : Object.keys(repository.spec.checks ?? {});
      if (!policyChecks?.includes(request.check)) {
        throw new StoreError(`check "${request.check}" is not authorized for ${origin.purpose}`, "Invalid");
      }
      const config = checkConfig(repository, request.check);
      if (this.d.redactor.redact(config.command) !== config.command) throw new StoreError("check command contains a factory secret", "Invalid");

      const profile = repository.spec.sandboxRef
        ? await resolveRef<SandboxProfile>(this.d.reader, "SandboxProfile", repository.spec.sandboxRef, namespace)
        : null;
      if (repository.spec.sandboxRef && !profile) throw new StoreError("repository sandbox profile not found", "NotFound");
      const selected = await this.d.environments.select();
      if (!selected.health.available) {
        throw new SandboxUnavailableError(selected.health.runtime, selected.health.message ?? "execution runtime unavailable");
      }

      const agents = await this.d.reader.list<AgentRun>("AgentRun", {
        namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
      });
      this.validateActiveAgents(item, origin, agents);
      const activeChecks = await this.d.reader.list<CheckRun>("CheckRun", {
        namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
      });
      if (activeChecks.some((run) => run.spec.workItemUid === item.metadata.uid && (!run.status || run.status.phase === "Running"))) {
        throw new StoreError("another check is pending or running for this work item", "Conflict");
      }

      const snapshot = await this.d.snapshots.fingerprint(workspace);
      const currentItem = await this.d.reader.get<WorkItem>("WorkItem", namespace, item.metadata.name);
      if (!currentItem || currentItem.metadata.uid !== item.metadata.uid || !itemMatchesOrigin(currentItem, origin)) {
        throw new StoreError("work item stage changed during check submission", "Conflict");
      }
      const run: CheckRun = {
        apiVersion: API_VERSION,
        kind: "CheckRun",
        metadata: { name, namespace, ownerReferences: [ownerRef(item)] },
        spec: {
          workItemRef: { name: item.metadata.name },
          workItemUid: item.metadata.uid,
          workspaceRef: { name: workspace.metadata.name },
          workspaceUid: workspace.metadata.uid,
          repositoryRef: { name: repository.metadata.name, namespace: nsOf(repository) === namespace ? undefined : nsOf(repository) },
          repositoryVersion: repository.metadata.resourceVersion!,
          check: request.check,
          ...config,
          snapshot,
          environment: {
            runtime: selected.health.runtime,
            version: selected.health.version,
            profileVersion: profile?.metadata.resourceVersion ?? "default",
          },
          requestedBy: request.requestedBy,
          requestFingerprint,
          workflow: origin,
        },
      };
      try {
        return await this.d.writer.create(run);
      } catch (error) {
        if (!isStoreError(error, "AlreadyExists")) throw error;
        const duplicate = await this.d.reader.get<CheckRun>("CheckRun", namespace, name);
        if (duplicate?.spec.requestFingerprint === requestFingerprint && isOwnedBy(item, duplicate)) return duplicate;
        throw new StoreError("conflicting concurrent workflow check request", "Conflict");
      }
    } finally {
      this.submitting.delete(lock);
    }
  }

  private validateActiveAgents(item: WorkItem, origin: CheckWorkflowOrigin, agents: AgentRun[]): void {
    const namespace = nsOf(item);
    const active = agents.filter((run) => run.spec.workItemRef.name === item.metadata.name &&
      ["Running", "Pending"].includes(run.status?.phase ?? "Pending"));
    if (!origin.agentRunRef) {
      if (active.length) throw new StoreError("work item has active agent runs", "Conflict");
      return;
    }
    if (origin.agentRunRef.namespace && origin.agentRunRef.namespace !== namespace) {
      throw new StoreError("workflow agentRunRef must be in the work item's namespace", "Invalid");
    }
    const caller = active.find((run) => run.metadata.name === origin.agentRunRef!.name);
    const expectedPrefix = `${item.metadata.name}-${origin.stage}-`;
    const isCurrentCaller = caller &&
      nsOf(caller) === namespace &&
      caller.status?.phase === "Running" &&
      caller.metadata.uid === origin.agentRunUid &&
      caller.spec.stage === origin.stage &&
      caller.spec.workItemRef.name === item.metadata.name &&
      (!caller.spec.workItemRef.namespace || caller.spec.workItemRef.namespace === namespace) &&
      !caller.spec.replayOf &&
      caller.metadata.labels?.[LABEL_SUPERSEDED] === undefined &&
      caller.metadata.labels?.["factory.ai-dlc.io/stage"] === origin.stage &&
      caller.metadata.labels?.["factory.ai-dlc.io/workitem"] === item.metadata.name &&
      caller.metadata.name.startsWith(expectedPrefix) &&
      caller.metadata.name.endsWith(`-r${origin.round}`) &&
      caller.metadata.ownerReferences?.some((owner) =>
        owner.kind === "WorkItem" && owner.name === item.metadata.name && owner.uid === item.metadata.uid);
    if (!isCurrentCaller) throw new StoreError("workflow caller is not an active, current-round AgentRun", "Invalid");
    if (active.some((run) => run.metadata.name !== caller!.metadata.name)) {
      throw new StoreError("another agent run is active for this work item", "Conflict");
    }
  }
}
