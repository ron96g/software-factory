import type { CheckRun, CheckWorkflowOrigin, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import { TEST_PATH_SEPARATOR } from "../model/tests.ts";
import { autoWaiveProblems } from "../model/auto-waive.ts";
import { isScoped, minScopeProblems, requestedScope } from "../model/check-scope.ts";
import { StoreError, type ModuleScopePlanner, type ResourceReader } from "../ports/index.ts";

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
      config.scoped !== undefined && typeof config.scoped !== "boolean" ||
      config.rerunFailed !== undefined && (typeof config.rerunFailed !== "string" || !config.rerunFailed.trim())) {
    throw new StoreError(`check "${name}" requires a command and a timeoutMs between 1 and 86400000`, "Invalid");
  }
  const unknown = [...new Set([...config.command.matchAll(PLACEHOLDER)].map(([token]) => token).filter((token) => token !== BASE_COMMIT_TOKEN))];
  if (unknown.length) throw new StoreError(`check "${name}" uses unknown command placeholders: ${unknown.join(", ")}`, "Invalid");
  if (config.scoped && config.moduleScoped) throw new StoreError(`check "${name}" sets both scoped and the legacy moduleScoped`, "Invalid");
  if (config.rerunFailed !== undefined && config.resultFormat !== "node-test-tap") {
    throw new StoreError(`check "${name}" rerunFailed needs resultFormat node-test-tap (per-test results)`, "Invalid");
  }
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

const MAX_RERUN_TESTS = 50;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const SAFE_FILE = /^[A-Za-z0-9._/-]+$/;

/**
 * ADR-0086: the command that runs only the failed tests of `original`, on the same snapshot. Test names and files come
 * from workspace output, so they reach the command only as single-quoted variable values, never as command text. The
 * pattern also names every ancestor so Node runs the enclosing tests (it matches names joined by spaces).
 */
export function rerunCheckConfig(repository: Repository, name: string, original: CheckRun) {
  const { timeoutMs, resultFormat } = checkConfig(repository, name);
  const value = repository.spec.checks?.[name];
  const template = typeof value === "object" ? value.rerunFailed : undefined;
  if (!template) throw new StoreError(`check "${name}" has no rerunFailed command`, "Invalid");
  const failed = original.status?.tests?.failed ?? [];
  if (original.spec.check !== name || original.status?.outcome !== "AssertionFailed" || !failed.length || failed.length > MAX_RERUN_TESTS) {
    throw new StoreError(`${original.metadata.name} has no named test failures to re-run`, "Invalid");
  }
  const files = [...new Set(failed.map((t) => t.file ?? ""))].sort();
  if (files.some((file) => !SAFE_FILE.test(file) || file.startsWith("-") || file.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new StoreError("failed tests need safe workspace-relative files to be re-run", "Invalid");
  }
  const names = new Set<string>();
  for (const test of failed) {
    if (test.name.length > 256 || /[\x00-\x1f\x7f]/.test(test.name)) throw new StoreError("a failed test name is not safe to re-run", "Invalid");
    const parts = test.name.split(TEST_PATH_SEPARATOR);
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join(" "));
  }
  const pattern = `^(${[...names].sort().map(escapeRegex).join("|")})$`;
  return {
    command: `export FACTORY_RERUN_PATTERN=${quote(pattern)}\nexport FACTORY_RERUN_FILES=${quote(files.join(" "))}\n${template}`,
    timeoutMs, resultFormat, scope: undefined,
  };
}

/** ADR-0086: the completed attempt a `rerun-failed` origin names, if it belongs to the same item, workspace and check. */
export async function rerunOriginal(reader: ResourceReader, item: WorkItem, workspace: Workspace, check: string, origin: CheckWorkflowOrigin): Promise<CheckRun> {
  const original = origin.rerunOf ? await reader.get<CheckRun>("CheckRun", nsOf(item), origin.rerunOf) : null;
  if (!original || original.spec.workItemUid !== item.metadata.uid || original.spec.workspaceUid !== workspace.metadata.uid ||
      original.spec.check !== check || original.status?.phase !== "Completed" || original.spec.workflow?.purpose === "rerun-failed" ||
      !original.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === item.metadata.uid)) {
    throw new StoreError("a targeted re-run must name a completed attempt of the same item, workspace and check", "Invalid");
  }
  return original;
}

/** ADR-0086 §3: the repository declares a targeted re-run and `original`'s failures can be named safely. */
export function canRerunFailed(repository: Repository, check: string, original: CheckRun): boolean {
  try { rerunCheckConfig(repository, check, original); return true; } catch { return false; }
}
