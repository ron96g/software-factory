import type { AgentRun, Artifact, RunProvenance } from "../../model/kinds.ts";
import { API_VERSION } from "../../model/resource.ts";
import { keyOf, ownerOf, parseKey } from "../../model/meta.ts";
import {
  isStoreError,
  type AgentExecutor,
  type Clock,
  type Controller,
  type EventRecorder,
  type ExecutionContextFactory,
  type InitialKeys,
  type Redactor,
  type ResourceReader,
  type ResourceWriter,
  type StatusWriter,
  type TranscriptRecorderFactory,
} from "../../ports/index.ts";

export interface AgentRunControllerDeps {
  reader: ResourceReader;
  writer: ResourceWriter;
  status: StatusWriter;
  events: EventRecorder;
  clock: Clock;
  contexts: ExecutionContextFactory;
  executor: AgentExecutor;
  recorders: TranscriptRecorderFactory;
  redactor: Redactor;
}

/**
 * Executes AgentRuns (Job pattern). Execution happens outside the reconcile (in-flight guard),
 * so a `Running` run found after a restart is simply executed again.
 */
export function createAgentRunController(d: AgentRunControllerDeps): Controller & InitialKeys {
  const inFlight = new Set<string>();

  async function execute(key: string, run: AgentRun) {
    const ns = run.metadata.namespace ?? "default";
    try {
      const recorder = await d.recorders.forRun(run);
      let current = run;
      if (current.status?.phase !== "Running" || !current.status.transcriptRef) {
        current = await d.status.updateStatus({
          ...current,
          status: { phase: "Running", startedAt: d.clock.now().toISOString(), transcriptRef: recorder.ref },
        });
        await d.events.normal(current, "Started", `${run.spec.agentRef.name} · ${run.spec.stage}/${run.spec.step}`);
      }
      const ctx = await d.contexts.create(current);
      const result = await d.executor.execute({ ...ctx, transcript: recorder });

      const outputs: { name: string }[] = [];
      for (const a of result.artifacts ?? []) {
        const name = `${run.metadata.name}-${a.type}`;
        const art: Artifact = {
          apiVersion: API_VERSION,
          kind: "Artifact",
          metadata: {
            name,
            namespace: ns,
            ownerReferences: run.metadata.ownerReferences,
            labels: { "factory.ai-dlc.io/workitem": run.spec.workItemRef.name, "factory.ai-dlc.io/artifact-type": a.type },
          },
          spec: {
            artifactTypeRef: { name: a.type },
            workItemRef: run.spec.workItemRef,
            producedBy: { agentRunRef: { name: run.metadata.name }, agentRef: run.spec.agentRef },
            format: a.format ?? "markdown",
            content: a.content,
          },
        };
        try {
          await d.writer.create(art);
        } catch (e) {
          if (!isStoreError(e, "AlreadyExists")) throw e;
        }
        outputs.push({ name });
      }

      const provenance: RunProvenance = {
        executor: d.executor.name,
        definitions: {
          [`Agent/${ctx.agent.metadata.name}`]: ctx.agent.metadata.resourceVersion ?? "",
          ...Object.fromEntries(ctx.skills.map((s) => [`Skill/${s.metadata.name}`, s.metadata.resourceVersion ?? ""])),
        },
        inputs: Object.fromEntries(ctx.inputs.map((a) => [a.metadata.name, a.metadata.resourceVersion ?? ""])),
        clarifications: ctx.clarifications.map((c) => c.metadata.name),
        ...result.provenance,
      };
      const latest = (await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name))!;
      const done = await d.status.updateStatus({
        ...latest,
        status: {
          ...latest.status!,
          phase: "Succeeded",
          finishedAt: d.clock.now().toISOString(),
          executor: provenance.executor,
          outputs,
          provenance,
          result: {
            summary: result.summary,
            outcome: result.outcome,
            classification: result.classification,
            questions: result.questions,
          },
        },
      });
      await d.events.normal(done, "Succeeded", result.summary ?? `${outputs.length} artifact(s)`);
    } catch (e) {
      const message = d.redactor.redact(e instanceof Error ? e.message : String(e)); // ADR-0015
      const latest = await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name);
      if (latest) {
        await d.status.updateStatus({ ...latest, status: { ...latest.status!, phase: "Failed", finishedAt: d.clock.now().toISOString(), message } });
        await d.events.warning(latest, "Failed", message);
      }
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    name: "agentrun",
    watches: ["AgentRun"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    initialKeys: async () =>
      (await d.reader.list<AgentRun>("AgentRun")).filter((r) => !["Succeeded", "Failed"].includes(r.status?.phase ?? "")).map(keyOf),

    async reconcile(key) {
      if (inFlight.has(key)) return;
      const { namespace, name } = parseKey(key);
      const run = await d.reader.get<AgentRun>("AgentRun", namespace, name);
      if (!run || run.status?.phase === "Succeeded" || run.status?.phase === "Failed") return;
      if (!ownerOf(run, "WorkItem")) return;
      inFlight.add(key);
      void execute(key, run);
    },
  };
}
