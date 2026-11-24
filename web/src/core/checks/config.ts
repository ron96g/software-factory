import type { CheckWorkflowOrigin, Repository, Workspace } from "../model/kinds.ts";
import { autoWaiveProblems } from "../model/auto-waive.ts";
import { isScoped, minScopeProblems, requestedScope } from "../model/check-scope.ts";
import { StoreError, type ModuleScopePlanner } from "../ports/index.ts";

/**
 * ADR-0083: a check command may name the candidate's pinned base commit instead of guessing a ref. The factory
 * substitutes it from the workspace, so a check can never be handed the wrong revision.
 */
export const BASE_COMMIT_TOKEN = "{{base}}";
const PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const pinnedCommit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);

/** Substitutes `{{base}}` (a validated hex commit, so it carries no shell syntax). */
export function withBaseCommit(command: string, workspace: Workspace): string {
  if (!command.includes(BASE_COMMIT_TOKEN)) return command;
  const base = workspace.status?.baseCommit;
  if (!pinnedCommit(base)) {
    throw new StoreError(`check command needs ${BASE_COMMIT_TOKEN}, but the workspace has no pinned base commit`, "Invalid");
  }
  return command.split(BASE_COMMIT_TOKEN).join(base);
}

export function checkConfig(repository: Repository, name: string) {
  const value = repository.spec.checks?.[name];
  if (value === undefined) throw new StoreError(`check "${name}" is not configured on ${repository.metadata.name}`, "Invalid");
  const config = typeof value === "string" ? { command: value } : value;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new StoreError(`check "${name}" must have a command configuration`, "Invalid");
  }
  const problems = autoWaiveProblems(repository);
  if (problems.length) throw new StoreError(problems.join("; "), "Invalid");
  if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1)) {
    throw new StoreError(`check "${name}" maxOutputBytes must be a positive integer`, "Invalid");
  }
  const timeoutMs = config.timeoutMs ?? 900_000;
  if (typeof config.command !== "string" || !config.command.trim() ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 ||
      config.resultFormat !== undefined && (typeof config.resultFormat !== "string" || !config.resultFormat.trim()) ||
      config.moduleScoped !== undefined && typeof config.moduleScoped !== "boolean" ||
      config.scoped !== undefined && typeof config.scoped !== "boolean") {
    throw new StoreError(`check "${name}" requires a command and a timeoutMs between 1 and 86400000`, "Invalid");
  }
  const unknown = [...new Set([...config.command.matchAll(PLACEHOLDER)].map(([token]) => token).filter((token) => token !== BASE_COMMIT_TOKEN))];
  if (unknown.length) throw new StoreError(`check "${name}" uses unknown command placeholders: ${unknown.join(", ")}`, "Invalid");
  if (config.scoped && config.moduleScoped) throw new StoreError(`check "${name}" sets both scoped and the legacy moduleScoped`, "Invalid");
  if ((config.scoped || config.moduleScoped) && (!repository.spec.moduleScope || !/^make [a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(config.command))) {
    throw new StoreError(`module-scoped check "${name}" requires moduleScope policy and a single named make target`, "Invalid");
  }
  return { command: config.command, timeoutMs, resultFormat: config.resultFormat };
}

export async function resolveCheckConfig(repository: Repository, name: string, workspace: Workspace, scopes?: ModuleScopePlanner,
  purpose?: CheckWorkflowOrigin["purpose"]) {
  const config = checkConfig(repository, name);
  const command = withBaseCommit(config.command, workspace);
  if (!isScoped(repository, name)) return { ...config, command, scope: undefined };
  if (!scopes) throw new StoreError("module scope planner is unavailable", "Invalid");
  const problems = minScopeProblems(repository);
  if (problems.length) throw new StoreError(problems.join("; "), "Invalid");
  const scope = await scopes.plan(workspace, repository, requestedScope(repository, name, purpose));
  if (!scope.modules.length || scope.modules.some((path) => !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new StoreError("module scope contains empty or unsafe Make arguments", "Invalid");
  }
  return { ...config, scope, command: scope.mode === "full" ? command : `${command} MODULES='${scope.modules.join(" ")}'` };
}
