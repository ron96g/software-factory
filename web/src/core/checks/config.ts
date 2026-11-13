import type { Repository } from "../model/kinds.ts";
import { StoreError } from "../ports/index.ts";

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
      config.resultFormat !== undefined && (typeof config.resultFormat !== "string" || !config.resultFormat.trim())) {
    throw new StoreError(`check "${name}" requires a command and a timeoutMs between 1 and 86400000`, "Invalid");
  }
  return { command: config.command, timeoutMs, resultFormat: config.resultFormat };
}
