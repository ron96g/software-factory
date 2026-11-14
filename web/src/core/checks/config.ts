import type { Repository, Workspace } from "../model/kinds.ts";
import { StoreError, type ModuleScopePlanner } from "../ports/index.ts";

export function checkConfig(repository: Repository, name: string) {
  const value = repository.spec.checks?.[name];
  if (value === undefined) throw new StoreError(`check "${name}" is not configured on ${repository.metadata.name}`, "Invalid");
  const config = typeof value === "string" ? { command: value } : value;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new StoreError(`check "${name}" must have a command configuration`, "Invalid");
  }
  const timeoutMs = config.timeoutMs ?? 900_000;
  if (typeof config.command !== "string" || !config.command.trim() ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 ||
      config.resultFormat !== undefined && (typeof config.resultFormat !== "string" || !config.resultFormat.trim()) ||
      config.moduleScoped !== undefined && typeof config.moduleScoped !== "boolean") {
    throw new StoreError(`check "${name}" requires a command and a timeoutMs between 1 and 86400000`, "Invalid");
  }
  if (config.moduleScoped && (!repository.spec.moduleScope || !/^make [a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(config.command))) {
    throw new StoreError(`module-scoped check "${name}" requires moduleScope policy and a single named make target`, "Invalid");
  }
  return { command: config.command, timeoutMs, resultFormat: config.resultFormat };
}

export async function resolveCheckConfig(repository: Repository, name: string, workspace: Workspace, scopes?: ModuleScopePlanner) {
  const config = checkConfig(repository, name);
  const value = repository.spec.checks?.[name];
  if (typeof value !== "object" || !value?.moduleScoped) return { ...config, scope: undefined };
  if (!scopes) throw new StoreError("module scope planner is unavailable", "Invalid");
  const scope = await scopes.plan(workspace, repository);
  if (!scope.modules.length || scope.modules.some((path) => !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new StoreError("module scope contains empty or unsafe Make arguments", "Invalid");
  }
  return { ...config, scope, command: scope.mode === "affected" ? `${config.command} MODULES='${scope.modules.join(" ")}'` : config.command };
}
