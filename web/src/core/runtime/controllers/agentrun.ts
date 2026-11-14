import type { AgentRun, Artifact, KnowledgeEntry, RunProvenance } from "../../model/kinds.ts";
import { LABEL_WORKITEM } from "../event-recorder.ts";
import { LABEL_SUPERSEDED } from "../../model/kinds.ts";
import { API_VERSION } from "../../model/resource.ts";
import { keyOf, ownerOf, parseKey } from "../../model/meta.ts";
import {
  isModelUnavailable,
  isStoreError,
  type AgentExecutor,
  type Clock,
  type Controller,
  type EventRecorder,
  type ExecutionContextFactory,
  type ExecutionContextPreviewer,
  type ExecutionGate,
  type InitialKeys,
  type Lifecycle,
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
  onError: (message: string) => void;
  /** ADR-0029: when set, runs wait (Pending) until the gate says ready, judged on a side-effect free preview. */
  gate?: { policy: ExecutionGate; previews: ExecutionContextPreviewer };
}

/**
 * Executes AgentRuns (Job pattern). Execution happens outside the reconcile (in-flight guard),
 * so a `Running` run found after a restart is simply executed again.
 */
const MODEL_RETRY_BASE_MS = 60_000;
const MODEL_RETRY_MAX_MS = 15 * 60_000;

export function createAgentRunController(d: AgentRunControllerDeps): Controller & InitialKeys & Pick<Lifecycle, "stop"> {
  const inFlight = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const seenSinceStart = new Set<string>();

  async function execute(key: string, run: AgentRun) {
    const ns = run.metadata.namespace ?? "default";
    try {
      // Fresh read: a restart may have relabelled the run since the reconcile read it.
      let current = (await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name)) ?? run;
      const recorder = await d.recorders.forRun(current);
      if (current.status?.phase !== "Running" || !current.status.transcriptRef) {
        current = await d.status.updateStatus({
          ...current,
          // modelWaits survives a retry so the backoff keeps growing while the model stays unavailable.
          status: { phase: "Running", startedAt: d.clock.now().toISOString(), transcriptRef: recorder.ref, modelWaits: current.status?.modelWaits },
        });
        await d.events.normal(current, "Started", `${run.spec.agentRef.name} · ${run.spec.stage}/${run.spec.step}`);
      }
      const ctx = await d.contexts.create(current);
      const result = await d.executor.execute({ ...ctx, transcript: recorder });

      const outputs: { name: string }[] = [];
      const superseded = (await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name))?.metadata.labels?.[LABEL_SUPERSEDED];
      for (const a of result.artifacts ?? []) {
        const name = `${run.metadata.name}-${a.type}`;
        const art: Artifact = {
          apiVersion: API_VERSION,
          kind: "Artifact",
          metadata: {
            name,
            namespace: ns,
            ownerReferences: run.metadata.ownerReferences,
            labels: {
              "factory.ai-dlc.io/workitem": run.spec.workItemRef.name,
              "factory.ai-dlc.io/artifact-type": a.type,
              ...(run.spec.replayOf ? { "factory.ai-dlc.io/replay": run.spec.replayOf.name } : {}),
              ...(superseded ? { [LABEL_SUPERSEDED]: superseded } : {}),
            },
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

      // ADR-0030: proposals only. Replays are side-effect free and superseded output is stale, so neither proposes.
      const proposed: string[] = [];
      const mayPropose = ctx.skills.some((s) => s.metadata.name === "knowledge-base");
      if (!run.spec.replayOf && !superseded && mayPropose) {
        for (const [i, k] of (result.knowledge ?? []).entries()) {
          const entry: KnowledgeEntry = {
            apiVersion: API_VERSION,
            kind: "KnowledgeEntry",
            metadata: {
              name: `${run.metadata.name}-k${i}`.slice(0, 200),
              namespace: ns,
              // No ownerReferences: knowledge outlives the item and the run.
              labels: { [LABEL_WORKITEM]: ctx.workItem.metadata.name, "factory.ai-dlc.io/agentrun": run.metadata.name },
            },
            spec: {
              title: d.redactor.redact(k.title),
              content: d.redactor.redact(k.content),
              tags: k.tags?.map((t) => d.redactor.redact(t)),
              scope: {
                repositories: ctx.workItem.spec.repositoryRefs?.map((r) => r.name),
                workflows: ctx.workItem.spec.workflowRef ? [ctx.workItem.spec.workflowRef.name] : undefined,
              },
              provenance: { agent: run.spec.agentRef.name, agentRun: run.metadata.name, workItem: ctx.workItem.metadata.name, proposedAt: d.clock.now().toISOString() },
            },
          };
          try {
            await d.writer.create(entry);
            proposed.push(entry.metadata.name);
          } catch (e) {
            // A re-executed run never overwrites an entry a human may already have reviewed.
            if (!isStoreError(e, "AlreadyExists")) throw e;
          }
        }
      }

      const provenance: RunProvenance = {
        executor: d.executor.name,
        definitions: {
          ...Object.fromEntries(Object.entries(ctx.workflowVersions ?? {}).map(([key, value]) => [`Workflow/${key}`, value])),
          [`Agent/${ctx.agent.metadata.name}`]: ctx.agent.metadata.resourceVersion ?? "",
          ...Object.fromEntries(ctx.skills.map((s) => [`Skill/${s.metadata.name}`, s.metadata.resourceVersion ?? ""])),
        },
        inputs: Object.fromEntries(ctx.inputs.map((a) => [a.metadata.name, a.metadata.resourceVersion ?? ""])),
        clarifications: ctx.clarifications.map((c) => c.metadata.name),
        ...result.provenance,
        replayOf: run.spec.replayOf,
        workspaces: ctx.workspaces.length
          ? Object.fromEntries(ctx.workspaces.map((w) => [w.spec.repositoryRef.name, w.status?.baseCommit ?? ""]))
          : undefined,
        executionEnvironment: ctx.sandbox ? `${ctx.sandbox.runtime}${ctx.sandbox.version ? `@${ctx.sandbox.version}` : ""}` : undefined,
      };
      const latest = (await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name))!;
      const done = await d.status.updateStatus({
        ...latest,
        status: {
          ...latest.status!,
          phase: "Succeeded",
          finishedAt: d.clock.now().toISOString(),
          retryAt: undefined,
          modelWaits: undefined,
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
      if (proposed.length) await d.events.normal(done, "KnowledgeProposed", `${proposed.length} entr${proposed.length === 1 ? "y" : "ies"} awaiting review: ${proposed.join(", ")}`);
    } catch (e) {
      const message = d.redactor.redact(e instanceof Error ? e.message : String(e)).trim(); // ADR-0015
      const latest = await d.reader.get<AgentRun>("AgentRun", ns, run.metadata.name);
      if (latest?.status?.phase === "Succeeded") {
        // Retrying audit publication must not rerun an already completed business agent.
        throw e;
      }
      if (latest && isModelUnavailable(e)) {
        // Quota / rate limit is not the agent's fault: wait and retry instead of failing the work item.
        const waits = (latest.status?.modelWaits ?? 0) + 1;
        // Capped even when Retry-After says "until the quota resets": a new token or budget should be picked up soon.
        const delay = Math.min(e.retryAfterMs ?? MODEL_RETRY_BASE_MS * 2 ** (waits - 1), MODEL_RETRY_MAX_MS);
        const retryAt = new Date(d.clock.now().getTime() + delay).toISOString();
        const recorder = await d.recorders.forRun(latest);
        await recorder.record({ role: "note", author: { type: "system", id: "agentrun" }, content: `model unavailable (${message}); retrying at ${retryAt}` });
        // Release the in-flight guard before the status write, so the resulting reconcile can schedule the retry.
        inFlight.delete(key);
        const waiting = await d.status.updateStatus({ ...latest, status: { ...latest.status!, phase: "Pending", message: `Waiting for the model: ${message}`, retryAt, modelWaits: waits } });
        if (waits === 1) await d.events.warning(waiting, "ModelUnavailable", `${message}; the run waits and retries (next at ${retryAt})`);
        return;
      }
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
    primaryKind: "AgentRun",
    stop: async () => { await Promise.all([...jobs]); },
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
      try {
        if (run.metadata.labels?.[LABEL_SUPERSEDED] && run.status?.phase !== "Running") {
          // A restart replaced this run before it started; running it would only cost tokens.
          await d.status.updateStatus({ ...run, status: { ...run.status, phase: "Failed", finishedAt: d.clock.now().toISOString(), message: "superseded by a restart before it started" } });
          return;
        }
        // After a (re)start, retry once right away: restarts are when tokens or providers usually change.
        const firstLook = !seenSinceStart.has(key);
        seenSinceStart.add(key);
        const wait = run.status?.phase === "Pending" && run.status.retryAt && !firstLook ? Date.parse(run.status.retryAt) - d.clock.now().getTime() : 0;
        if (wait > 0) return { requeueAfterMs: Math.min(wait, MODEL_RETRY_MAX_MS) };
        if (d.gate && run.status?.phase !== "Running") {
          // A broken context fails the run inside execute(), with the error on the run.
          const preview = await d.gate.previews.preview(run).catch(() => undefined);
          const readiness = preview ? d.gate.policy.check(preview) : ({ ready: true } as const);
          if (!readiness.ready) {
            if (run.status?.phase !== "Pending" || run.status.message !== readiness.reason) {
              await d.status.updateStatus({ ...run, status: { ...run.status, phase: "Pending", message: readiness.reason } });
              await d.events.normal(run, "Waiting", readiness.reason);
            }
            return { requeueAfterMs: readiness.retryAfterMs };
          }
        }
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
      inFlight.add(key);
      const job = execute(key, run)
        .catch((e: unknown) => d.onError(d.redactor.redact(e instanceof Error ? e.message : String(e))))
        .finally(() => jobs.delete(job));
      jobs.add(job);
    },
  };
}
