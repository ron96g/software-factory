import type { AgentRun, CheckRun, CheckWorkflowOrigin, Repository, SandboxProfile, WorkItem, Workflow, Workspace } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { DEFAULT_NAMESPACE } from "../model/resource.ts";
import type { ModuleScopePlanner, ResourceReader, Validator } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";
import { resolveCheckConfig } from "./config.ts";

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

async function validateWorkflowOrigin(run: CheckRun, item: WorkItem, repository: Repository | null, reader: ResourceReader): Promise<string[]> {
  const origin = run.spec.workflow;
  if (!origin) return [];
  if (!validWorkflowOrigin(origin)) return ["workflow origin is malformed"];
  if (!repository) return ["workflow check repository is unavailable"];
  if (!["Running", "Waiting"].includes(item.status?.phase ?? "") ||
      item.status?.stage !== origin.stage || item.status?.round !== origin.round ||
      item.spec.restart && item.spec.restart.id !== item.status?.restartHandled) {
    return ["workflow origin does not match the current work item stage and round"];
  }
  const workflow = item.spec.workflowRef
    ? await resolveRef<Workflow>(reader, "Workflow", item.spec.workflowRef, nsOf(item))
    : null;
  const policy = workflow?.spec.verification;
  if (!workflow || !policy ||
      (origin.purpose === "preflight" ? policy.preflightStage :
        origin.purpose === "preparation" ? policy.preparationStage : policy.verifyStage) !== origin.stage) {
    return ["workflow origin is not authorized by the current verification policy"];
  }
  const allowedChecks = origin.purpose === "preflight"
    ? repository.spec.verification?.preflightChecks
    : origin.purpose === "preparation" ? repository.spec.verification?.preparationChecks
    : Object.keys(repository.spec.checks ?? {});
  if (!allowedChecks?.includes(run.spec.check)) return [`check "${run.spec.check}" is not authorized for ${origin.purpose}`];

  const namespace = nsOf(item);
  const agents = await reader.list<AgentRun>("AgentRun", {
    namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
  });
  const active = agents.filter((agent) => ["Running", "Pending"].includes(agent.status?.phase ?? "Pending"));
  if (!origin.agentRunRef) return active.length ? ["work item has active agent runs"] : [];
  if (origin.agentRunRef.namespace && origin.agentRunRef.namespace !== namespace) return ["workflow caller is outside the work item namespace"];
  const caller = active.find((agent) => agent.metadata.name === origin.agentRunRef!.name);
  const expectedPrefix = `${item.metadata.name}-${origin.stage}-`;
  const validCaller = caller &&
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
    isOwnedBy(item, caller);
  if (!validCaller) return ["workflow caller is not an active, current-round AgentRun"];
  if (active.some((agent) => agent.metadata.name !== caller!.metadata.name)) return ["another agent run is active for this work item"];
  return [];
}

export function checkRunValidator(scopes?: ModuleScopePlanner): Validator {
  return {
    name: "checkrun",
    appliesTo: (kind) => kind === "CheckRun",
    async validate(object, ctx) {
      const run = object as CheckRun;
      if (ctx.oldObject) {
        return JSON.stringify(object.spec) === JSON.stringify(ctx.oldObject.spec) &&
          JSON.stringify(object.metadata.ownerReferences) === JSON.stringify(ctx.oldObject.metadata.ownerReferences)
          ? [] : ["check spec and ownership are immutable"];
      }

      const spec = run.spec as Partial<CheckRun["spec"]>;
      const errors: string[] = [];
      for (const field of ["workItemUid", "workspaceUid", "repositoryVersion", "check", "command", "snapshot", "requestedBy", "requestFingerprint"] as const) {
        if (typeof spec[field] !== "string" || !spec[field]!.trim()) errors.push(`spec.${field} is required`);
      }
      if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs! < 1 || spec.timeoutMs! > 86_400_000) errors.push("invalid check timeoutMs");
      if (!spec.environment?.runtime || !spec.environment.profileVersion) errors.push("execution environment identity is required");
      if (!spec.workItemRef?.name || !spec.workspaceRef?.name || !spec.repositoryRef?.name) errors.push("check origin references are required");
      if (run.status) errors.push("new CheckRuns must be Pending without status");

      const namespace = nsOf(run);
      if (spec.workItemRef?.namespace && spec.workItemRef.namespace !== namespace) errors.push("work item reference must be namespace-local");
      if (spec.workspaceRef?.namespace && spec.workspaceRef.namespace !== namespace) errors.push("workspace reference must be namespace-local");
      const item = spec.workItemRef?.name
        ? await ctx.reader.get<WorkItem>("WorkItem", namespace, spec.workItemRef.name)
        : null;
      if (!item || item.metadata.uid !== spec.workItemUid || !isOwnedBy(item, run)) {
        errors.push("CheckRun must be owned by its current WorkItem UID");
        return errors;
      }
      const workspace = spec.workspaceRef?.name
        ? await ctx.reader.get<Workspace>("Workspace", namespace, spec.workspaceRef.name)
        : null;
      if (!workspace || workspace.metadata.uid !== spec.workspaceUid ||
          workspace.status?.phase !== "Ready" || !workspace.status.path ||
          workspace.spec.workItemRef.name !== item.metadata.name || !isOwnedBy(item, workspace)) {
        errors.push("CheckRun must reference a Ready workspace owned by its WorkItem");
      }
      const repository = workspace
        ? await resolveRef<Repository>(ctx.reader, "Repository", workspace.spec.repositoryRef, namespace)
        : null;
      if (!repository || repository.metadata.name !== spec.repositoryRef?.name ||
          (spec.repositoryRef?.namespace && spec.repositoryRef.namespace !== nsOf(repository)) ||
          repository.metadata.resourceVersion !== spec.repositoryVersion) {
        errors.push("CheckRun repository reference/version is not current");
      } else {
        try {
          const config = workspace && await resolveCheckConfig(repository, spec.check ?? "", workspace, scopes);
          if (!config) throw new Error("check workspace is unavailable");
          if (config.command !== spec.command || config.timeoutMs !== spec.timeoutMs ||
              config.resultFormat !== spec.resultFormat || JSON.stringify(config.scope) !== JSON.stringify(spec.scope)) {
            errors.push("CheckRun command, budget, scope or result format differs from repository policy");
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "CheckRun references an invalid repository check");
        }
        const profile = repository.spec.sandboxRef
          ? await resolveRef<SandboxProfile>(ctx.reader, "SandboxProfile", repository.spec.sandboxRef, namespace)
          : null;
        if (repository.spec.sandboxRef && (!profile || profile.metadata.resourceVersion !== spec.environment?.profileVersion)) {
          errors.push("CheckRun sandbox profile version is not current");
        }
        if (!repository.spec.sandboxRef && spec.environment?.profileVersion !== "default") {
          errors.push("CheckRun has an unexpected sandbox profile version");
        }
      }

      errors.push(...await validateWorkflowOrigin(run, item, repository, ctx.reader));
      const activeChecks = await ctx.reader.list<CheckRun>("CheckRun", {
        namespace, ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace },
      });
      if (activeChecks.some((check) => check.metadata.name !== run.metadata.name &&
          check.spec.workItemUid === item.metadata.uid && (!check.status || check.status.phase === "Running"))) {
        errors.push("another check is pending or running for this WorkItem");
      }
      return errors;
    },
  };
}
