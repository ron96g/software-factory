import { createHash } from "node:crypto";
import type { Repository } from "../model/kinds.ts";

/**
 * ADR-0064: the version of the part of a Repository definition that decides what a check runs and where. Validation
 * plans and check evidence bind to it instead of the Repository's resourceVersion, so editing publication (`git`),
 * code search (`index`), agent context or labels doesn't invalidate approved plans and passed checks. A Repository field
 * that starts to influence a check (e.g. `git.url` once a preparer clones from it) must be added here.
 */
export function checkDefinitionVersion(repository: Repository): string {
  const { local, workspace, sandboxRef, checks, moduleScope, verification } = repository.spec;
  const content = canonical({ local, workspace, sandboxRef, checks, moduleScope, verification });
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Key order in the YAML is not a change. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
