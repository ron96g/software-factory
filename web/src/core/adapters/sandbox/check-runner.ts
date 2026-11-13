import type { CheckRun, Repository, SandboxProfile, Workspace } from "../../model/kinds.ts";
import { API_VERSION, SYSTEM_NAMESPACE } from "../../model/resource.ts";
import { ISOLATION_RANK, SandboxUnavailableError, type CheckExecutionRunner, type ExecutionEnvironmentSelector, type ResourceReader } from "../../ports/index.ts";
import { resolveRef } from "../../refs/refs.ts";

export class SandboxCheckRunner implements CheckExecutionRunner {
  private readonly reader: ResourceReader;
  private readonly environments: ExecutionEnvironmentSelector;
  constructor(reader: ResourceReader, environments: ExecutionEnvironmentSelector) {
    this.reader = reader;
    this.environments = environments;
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
    const sandbox = await environment.prepare({ profile, repositories: [repository], workspaces: [workspace] });
    try { return await sandbox.exec(`set -e -o pipefail\n${run.spec.command}`, { timeoutMs: run.spec.timeoutMs }); }
    finally { await sandbox.dispose(); }
  }
}
