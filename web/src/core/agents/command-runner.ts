import type { Repository, SandboxProfile, Workspace } from "../model/kinds.ts";
import { API_VERSION, SYSTEM_NAMESPACE } from "../model/resource.ts";
import { nsOf } from "../model/meta.ts";
import { ISOLATION_RANK, type CommandRunner, type ExecutionEnvironmentSelector, type ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

/** Runs check commands in a workspace through the selected sandbox runtime (ADR-0023), honoring profile isolation. */
export class SandboxCommandRunner implements CommandRunner {
  private readonly reader: ResourceReader;
  private readonly environments: ExecutionEnvironmentSelector;
  constructor(reader: ResourceReader, environments: ExecutionEnvironmentSelector) {
    this.reader = reader;
    this.environments = environments;
  }

  async run(ws: Workspace, repositories: Repository[], command: string, timeoutMs = 15 * 60_000) {
    const repo = repositories.find((r) => r.metadata.name === ws.spec.repositoryRef.name);
    const profile =
      (repo?.spec.sandboxRef && (await resolveRef<SandboxProfile>(this.reader, "SandboxProfile", repo.spec.sandboxRef, nsOf(ws)))) ||
      ({ apiVersion: API_VERSION, kind: "SandboxProfile", metadata: { name: "default", namespace: SYSTEM_NAMESPACE }, spec: { image: "", isolation: "container" } } as SandboxProfile);
    const { environment, health } = await this.environments.select();
    if (!health.available) throw new Error(`no sandbox runtime available to run checks: ${health.message ?? ""}`);
    const required = profile.spec.isolation ?? "container";
    if (ISOLATION_RANK[health.isolation] < ISOLATION_RANK[required] && !health.waivesIsolation) {
      throw new Error(`runtime "${health.runtime}" provides isolation "${health.isolation}", profile requires "${required}"`);
    }
    const sandbox = await environment.prepare({ profile, repositories, workspaces: [ws] });
    try {
      const r = await sandbox.exec(command, { timeoutMs });
      return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim(), durationMs: r.durationMs };
    } finally {
      await sandbox.dispose().catch(() => {});
    }
  }
}
