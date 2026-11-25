import type { Repository, SandboxProfile, Workspace } from "../../model/kinds.ts";
import { SandboxUnavailableError, canCommitCandidate, type CandidateCommitter, type ExecutionEnvironmentSelector, type ResourceReader } from "../../ports/index.ts";
import { resolveRef } from "../../refs/refs.ts";
import { DEFAULT_SANDBOX_PROFILE, decideIsolation } from "../../agents/sandbox-isolation.ts";

/**
 * ADR-0092: the publication commit is made by the selected execution environment, under the repository's sandbox
 * profile. A runtime that cannot commit in a sandbox fails visibly; the factory never falls back to committing itself.
 */
export class SandboxCandidateCommitter implements CandidateCommitter {
  private readonly reader: ResourceReader;
  private readonly environments: ExecutionEnvironmentSelector;
  constructor(reader: ResourceReader, environments: ExecutionEnvironmentSelector) {
    this.reader = reader;
    this.environments = environments;
  }

  async commit(ws: Workspace, repo: Repository, input: { message: string; outDir: string }) {
    const { environment, health } = await this.environments.select();
    if (!health.available) throw new SandboxUnavailableError(health.runtime, health.message ?? "runtime unavailable");
    if (!canCommitCandidate(environment)) {
      throw new SandboxUnavailableError(health.runtime, `the ${health.runtime} runtime cannot make the publication commit in a sandbox (ADR-0092)`);
    }
    const profile = repo.spec.sandboxRef
      ? await resolveRef<SandboxProfile>(this.reader, "SandboxProfile", repo.spec.sandboxRef, ws.metadata.namespace!)
      : DEFAULT_SANDBOX_PROFILE;
    if (!profile) throw new SandboxUnavailableError(health.runtime, `sandbox profile ${repo.spec.sandboxRef?.name} not found`);
    try {
      decideIsolation(health, profile);
    } catch (e) {
      throw new SandboxUnavailableError(health.runtime, e instanceof Error ? e.message : String(e));
    }
    return environment.commitCandidate({ profile, repositories: [repo], workspaces: [ws] },
      { branch: ws.spec.branch, message: input.message, outDir: input.outDir, hooks: repo.spec.git?.commit?.hooks });
  }
}
