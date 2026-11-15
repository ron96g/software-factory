import { normalizeQuestions } from "../questions.ts";
import { nsOf } from "../model/meta.ts";
import { pinnedWorkspaceFiles } from "../code/pinned.ts";
import type { AgentRun, Workspace } from "../model/kinds.ts";
import type {
  AgentResult, ArtifactCheck, ArtifactProducer, ArtifactSchemaReader, ExecutionContext, FinishValidator, JsonSchemaValidator, Lookup,
  ProposedArtifactCheck, ResourceReader, WorkspaceReaderFactory,
} from "../ports/index.ts";

/** Structural JSON Schema contract first, then the type's domain check (ADR-0055). */
export function schemaArtifactCheck(
  artifactType: string, schemas: ArtifactSchemaReader, validator: JsonSchemaValidator, domain?: ProposedArtifactCheck,
): ProposedArtifactCheck {
  return {
    artifactType,
    async check(artifact) {
      const contract = await schemas.get(artifactType, nsOf(artifact.item));
      if (contract) {
        let value: unknown;
        try { value = JSON.parse(artifact.content); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return `Artifact content must be valid JSON matching its supplied ArtifactType schema: ${error.message}. Return corrected JSON without Markdown fences.`;
        }
        const error = validator.validate(contract.jsonSchema, value);
        if (error) return error;
      }
      return domain?.check(artifact);
    },
  };
}

const ready = (workspaces: Workspace[]) => workspaces.filter((w) => w.status?.phase === "Ready" && w.status.path);

/**
 * ADR-0057: post-run adapter. Rebuilds the producer's view from the persisted AgentRun and reopens its workspaces
 * only at the commits recorded in provenance; otherwise `files` is null and code-location checks fail.
 */
export function persistedArtifactCheck(check: ProposedArtifactCheck, d: { reader: ResourceReader; readers: WorkspaceReaderFactory }): ArtifactCheck {
  return {
    artifactType: check.artifactType,
    async check(item, artifact) {
      const runName = artifact.spec.producedBy?.agentRunRef.name;
      const run = runName ? await d.reader.get<AgentRun>("AgentRun", nsOf(artifact), runName) : undefined;
      const provenance = run?.status?.provenance;
      const { repositories, files } = await pinnedWorkspaceFiles(d.reader, d.readers, item, provenance);
      const producer: ArtifactProducer = {
        runName: runName ?? "", stage: run?.spec.stage ?? "", inputs: provenance?.inputs ?? {}, contexts: provenance?.contexts ?? {},
        outcome: run?.status?.result?.outcome, questions: normalizeQuestions(run?.status?.result?.questions).map((q) => q.text), repositories,
      };
      return check.check({ item, type: artifact.spec.artifactTypeRef.name, content: artifact.spec.content, producer, files });
    },
  };
}

/** ADR-0057: the same checks, applied to a proposed result before the producing run ends. */
export class RegistryFinishValidator implements FinishValidator {
  private readonly d: { checks: Lookup<ProposedArtifactCheck>; readers: WorkspaceReaderFactory };
  constructor(d: RegistryFinishValidator["d"]) { this.d = d; }

  async validate(ctx: ExecutionContext, result: AgentResult): Promise<string[]> {
    const problems: string[] = [];
    const artifacts = result.artifacts ?? [];
    for (const expected of ctx.run.spec.outputs) {
      if (this.d.checks.get(expected.name) && !artifacts.some((a) => a.type === expected.name)) problems.push(`Missing required output: ${expected.name}`);
    }
    // The run's own Ready workspaces: the commits its provenance will record and the post-run check reopens.
    const workspaces = ready(ctx.workspaces);
    const files = workspaces.length ? this.d.readers.forWorkspaces(workspaces) : null;
    const producer: ArtifactProducer = {
      runName: ctx.run.metadata.name, stage: ctx.run.spec.stage,
      inputs: Object.fromEntries(ctx.inputs.map((a) => [a.metadata.name, a.metadata.resourceVersion ?? ""])),
      contexts: Object.fromEntries(ctx.sections.filter((s) => s.revision).map((s) => [s.source, s.revision!])),
      outcome: result.outcome, questions: normalizeQuestions(result.questions).map((q) => q.text), repositories: workspaces.map((w) => w.spec.repositoryRef.name),
    };
    for (const artifact of artifacts) {
      const check = this.d.checks.get(artifact.type);
      const problem = check && await check.check({ item: ctx.workItem, type: artifact.type, content: artifact.content, producer, files });
      if (problem) problems.push(`${artifact.type}: ${problem}`);
    }
    return problems;
  }
}
