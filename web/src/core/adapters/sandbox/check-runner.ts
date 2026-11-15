import type { CheckRun, Repository, SandboxProfile, Workspace } from "../../model/kinds.ts";
import { API_VERSION, SYSTEM_NAMESPACE } from "../../model/resource.ts";
import { ISOLATION_RANK, SandboxUnavailableError, canPrepareIsolated, type CheckExecutionRunner, type ExecutionEnvironmentSelector, type ResourceReader } from "../../ports/index.ts";
import { resolveRef } from "../../refs/refs.ts";

/** ADR-0047: checks keep complete redacted logs up to an operator limit; truncation stays visibly incomplete. */
export const DEFAULT_CHECK_OUTPUT_BYTES = 16 * 1024 * 1024;

export class SandboxCheckRunner implements CheckExecutionRunner {
  private readonly reader: ResourceReader;
  private readonly environments: ExecutionEnvironmentSelector;
  private readonly maxOutputBytes: number;
  constructor(reader: ResourceReader, environments: ExecutionEnvironmentSelector, maxOutputBytes = DEFAULT_CHECK_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error("check output limit must be at least 1024 bytes");
    this.reader = reader;
    this.environments = environments;
    this.maxOutputBytes = maxOutputBytes;
  }

  async execute(run: CheckRun, workspace: Workspace, repository: Repository) {
    const { environment, health } = await this.environments.select();
    if (!health.available) throw new SandboxUnavailableError(health.runtime, health.message ?? "runtime unavailable");
    if (health.runtime !== run.spec.environment.runtime || health.version !== run.spec.environment.version) {
      throw new SandboxUnavailableError(health.runtime, "execution environment changed since check submission");
    }
    const profile = repository.spec.sandboxRef
      ? await resolveRef<SandboxProfile>(this.reader, "SandboxProfile", repository.spec.sandboxRef, run.metadata.namespace!)
      : { apiVersion: API_VERSION, kind: "SandboxProfile", metadata: { name: "default", namespace: SYSTEM_NAMESPACE }, spec: { image: "", isolation: "container" as const } };
    if (!profile || (profile.metadata.resourceVersion ?? "default") !== run.spec.environment.profileVersion) {
      throw new SandboxUnavailableError(health.runtime, "sandbox profile changed since check submission");
    }
    if (ISOLATION_RANK[health.isolation] < ISOLATION_RANK[profile.spec.isolation ?? "container"] && !health.waivesIsolation) {
      throw new SandboxUnavailableError(health.runtime, "runtime does not provide the profile's minimum isolation");
    }
    const spec = { profile, repositories: [repository], workspaces: [workspace] };
    const isolated = run.spec.workflow?.purpose === "diagnostic" || run.spec.workflow?.purpose === "baseline";
    if (isolated && (!canPrepareIsolated(environment) || !environment.isolatesCandidate || !workspace.status?.baseCommit)) {
      throw new SandboxUnavailableError(health.runtime, "diagnostic execution requires an isolated candidate snapshot");
    }
    if (run.spec.workflow?.purpose === "baseline" && run.spec.workflow.baselineCommit !== workspace.status?.baseCommit) {
      throw new SandboxUnavailableError(health.runtime, "workspace baseline changed since submission");
    }
    const sandbox = isolated && canPrepareIsolated(environment)
      ? await environment.prepareIsolated(spec, { commit: workspace.status!.baseCommit!, mode: run.spec.workflow?.purpose === "baseline" ? "baseline" : "candidate", snapshot: run.spec.snapshot })
      : await environment.prepare(spec);
    try { return await sandbox.exec(`set -e -o pipefail\n${run.spec.command}`, { timeoutMs: run.spec.timeoutMs, maxOutputBytes: this.maxOutputBytes }); }
    finally { await sandbox.dispose(); }
  }
}
