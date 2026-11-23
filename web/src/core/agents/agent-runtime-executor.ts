/**
 * ADR-0080 §2/§3: `AgentRuntimeExecutor` — an `AgentExecutor` that does **not** run the agent loop itself. It binds the
 * run's factory-side tool surface, serves it (with the model proxy) on a control channel, issues a run-scoped model
 * token, creates the run job on an `AgentRuntime` (which hosts the loop, the workspace and the toolchain), waits for it,
 * records the runtime-reported events, ingests the exported commit as data, and maps the untrusted `finish` arguments
 * into an `AgentResult`. Everything else in the control loop is unchanged.
 */
import type {
  AgentExecutor,
  AgentResult,
  AgentTool,
  AgentToolOffering,
  ExecutionContext,
  ExportIngestor,
  FinishValidator,
  Lookup,
  PromptBuilder,
  ResourceReader,
  RuntimeControlServer,
  RuntimeControlServerFactory,
  RuntimeJob,
  RuntimeJobSecrets,
  RuntimeJobSpec,
  RuntimeModelAccess,
  AgentRuntime,
  CandidateDiffer,
  SandboxHealthInfo,
  ToolCapabilities,
  ToolProvider,
} from "../ports/index.ts";
import { ModelUnavailableError, RUNTIME_PROTOCOL, RuntimeRefusedError } from "../ports/index.ts";
import { nsOf } from "../model/meta.ts";
import { DEFAULT_MAX_STEPS, finishResult, resolveSandboxProfile } from "./run-harness.ts";
import { buildRunToolSurface } from "./run-tool-surface.ts";
import { promptHash } from "./prompt-builder.ts";
import { decideIsolation, weakerIsolationNote } from "./sandbox-isolation.ts";

export interface AgentRuntimeExecutorDeps {
  runtime: AgentRuntime;
  reader: ResourceReader;
  prompts: PromptBuilder;
  tools: Lookup<AgentTool>;
  /** Issues/revokes the run-scoped model token the proxy verifies (ADR-0080 §4). */
  modelAccess: RuntimeModelAccess;
  /** Ingests the exported bundle into a factory-owned bare mirror (ADR-0080 §13). */
  export: ExportIngestor;
  /** Reads the candidate's diff from the bare mirror, through plumbing only (ADR-0080 §13). */
  diff: CandidateDiffer;
  /** Directory holding the per-run bare mirrors. */
  mirrorsDir: string;
  /** The factory-side capabilities for the tools served over the surface (checks, knowledge, egress, …). */
  capabilities(ctx: ExecutionContext): ToolCapabilities;
  /** The agent's MCP servers (ADR-0034), served factory-side. */
  toolProvider?: ToolProvider;
  offerings?: AgentToolOffering[];
  /** Starts the runtime-facing control surface (proxy + tool surface). Injected so this module imports no adapter (rule 3). */
  controlServer: RuntimeControlServerFactory;
  maxSteps?: number;
  ttlSeconds?: number;
  /** How long to wait for the runtime before failing the run (defaults to the run budget + a minute). */
  waitTimeoutMs?: number;
  finish?: FinishValidator;
}

export class AgentRuntimeExecutor implements AgentExecutor {
  readonly name = "agent-runtime";
  private readonly d: AgentRuntimeExecutorDeps;

  constructor(d: AgentRuntimeExecutorDeps) {
    this.d = d;
  }

  canExecute(ctx: ExecutionContext): boolean {
    const tools = ctx.agent.spec.tools ?? [];
    return !!ctx.model
      && !!ctx.agent.spec.sandboxRef
      && tools.length > 0
      && !tools.includes("finish")   // `finish` is the reserved protocol tool (a tool-surface call), never a definition tool
      && tools.every((t) => !!this.d.tools.get(t))
      && ctx.workspaces.some((w) => w.status?.phase === "Ready" && w.status.baseCommit);
  }

  async execute(ctx: ExecutionContext): Promise<AgentResult> {
    const sys = { type: "system" as const, id: "agent-runtime" };
    const model = ctx.model!;
    const { profile, fromRepository } = await resolveSandboxProfile(ctx, this.d.reader);
    const caps = await this.d.runtime.capabilities();
    const health: SandboxHealthInfo = { runtime: this.d.runtime.backend, available: true, isolation: caps.isolation };

    // §7: egress is deny-by-default. A profile with no explicit mode is treated as `none`; a mode the backend cannot
    // enforce is refused, never silently degraded.
    const wanted = profile.spec.network?.mode ?? "none";
    if (!caps.network.includes(wanted)) {
      throw new RuntimeRefusedError("network", `the "${this.d.runtime.backend}" runtime cannot enforce network mode "${wanted}" (profile ${profile.metadata.name}); ADR-0080 §7`);
    }
    const isolation = decideIsolation(health, profile);
    if (isolation.acceptedWeaker) {
      await ctx.transcript.record({ role: "note", author: sys, content: weakerIsolationNote(health, isolation) });
    }

    const prompt = this.d.prompts.build(ctx, "tools");
    const maxSteps = this.d.maxSteps ?? DEFAULT_MAX_STEPS;
    const ttlSeconds = this.d.ttlSeconds ?? 3600;
    const ns = nsOf(ctx.agent);
    const control = this.d.runtime.control(ctx.run.metadata);
    const spec: RuntimeJobSpec = {
      run: ctx.run.metadata,
      namespace: ctx.run.metadata.namespace ?? "default",
      // A label for S2-a/b; S3 pins a real image/rootfs hash.
      image: `${this.d.runtime.backend}@${caps.isolation}`,
      profile,
      seeds: ctx.workspaces
        .filter((w) => w.status?.phase === "Ready" && w.status.baseCommit)
        .map((w) => ({ repository: w.spec.repositoryRef.name, commit: w.status!.baseCommit!, path: w.status!.path })),
      model: { baseUrl: control.endpoint, name: model.model },
      tools: { baseUrl: control.endpoint },
      task: { system: prompt.system, user: prompt.user, maxSteps, protocol: RUNTIME_PROTOCOL },
      budgets: { ttlSeconds },
    };

    let job: RuntimeJob | undefined;
    let surface: Awaited<ReturnType<typeof buildRunToolSurface>> | undefined;
    let server: RuntimeControlServer | undefined;
    let issuedToken: string | undefined;
    let lastSeq = -1;
    // §8: runtime events are recorded on every path (success, wait, failure), marked `runtime-reported`, with a gap note.
    const recordEvents = async () => {
      if (!job) return;
      for (const e of await job.events(lastSeq)) {
        if (lastSeq >= 0 && e.seq > lastSeq + 1) {
          await ctx.transcript.record({ role: "note", author: sys, content: `[harness] runtime event sequence gap: ${lastSeq} → ${e.seq}`, meta: { runtimeReported: true, gap: true } });
        }
        await ctx.transcript.record({ role: "note", author: sys, content: `runtime-reported: ${e.content}`, meta: { runtimeReported: true, seq: e.seq, runtimeRole: e.role } });
        lastSeq = Math.max(lastSeq, e.seq);
      }
    };

    try {
      await control.prepare();
      const token = await this.d.modelAccess.issue(ctx.run.metadata, {
        providerRef: { name: model.provider, namespace: ns },
        models: [model.model],
        agent: ctx.agent.metadata.name,
        tier: model.tier,
        maxCalls: maxSteps,
        ttlSeconds,
      });
      issuedToken = token.token;

      // Bind the run's factory-side tools and serve them, with the proxy, on the runtime's control channel (§5). `finish`
      // is validated in-loop (ADR-0057), exactly like the in-process loop.
      surface = await buildRunToolSurface(ctx, {
        tools: this.d.tools,
        toolProvider: this.d.toolProvider,
        capabilities: this.d.capabilities,
        offerings: this.d.offerings,
        reader: this.d.reader,
        finish: async (args) => {
          const built = await finishResult(ctx, args, async () => "", { model, promptHash: promptHash(prompt), steps: 0, toolUse: { steps: 0, calls: {}, finishCorrections: 0 } });
          const problems = await this.validateFinish(ctx, built);
          return problems.length ? { ok: false, problems } : { ok: true };
        },
      });
      server = await this.d.controlServer.start({ endpoint: control.endpoint, surface: surface.surface, modelToken: token.token, toolToken: token.token });

      const secrets: RuntimeJobSecrets = { modelToken: token.token, toolToken: token.token };
      job = await this.d.runtime.create(spec, secrets);
      await ctx.transcript.record({ role: "note", author: sys,
        content: `runtime ${job.id} created (${this.d.runtime.backend}, profile ${profile.metadata.name}${fromRepository ? " from the repository" : " from the agent"})` });

      const result = await withTimeout(job.wait(), this.d.waitTimeoutMs ?? (ttlSeconds + 60) * 1000, "the runtime exceeded its deadline");
      if (result.status === "waiting") throw new ModelUnavailableError(result.message ?? "the runtime is waiting for the model", 429, result.retryAfterMs);
      if (result.status === "failed") throw new Error(result.message ?? "the agent runtime failed");
      if (result.finish === null || typeof result.finish !== "object" || Array.isArray(result.finish)) {
        throw new Error(`the runtime's finish payload must be a JSON object, got ${Array.isArray(result.finish) ? "array" : typeof result.finish}`);
      }

      const exported = await job.export();
      const ingested = await this.d.export.ingest({
        bundlePath: exported.bundlePath,
        mirrorPath: `${this.d.mirrorsDir}/${ctx.run.metadata.name}.git`,
        ref: exported.ref,
      });

      // Untrusted `finish`, validated exactly as the in-process loop does (ADR-0057). The diff comes from the ingested
      // commit, read through plumbing only (ADR-0080 §13); the checked-out candidate never reaches the factory.
      const seedCommit = spec.seeds[0]?.commit;
      const built = await finishResult(ctx, result.finish as Record<string, unknown>, async () =>
        seedCommit ? await this.d.diff.diff({ mirrorPath: `${this.d.mirrorsDir}/${ctx.run.metadata.name}.git`, base: seedCommit, candidate: ingested.commit }) : "", {
        model,
        promptHash: promptHash(prompt),
        steps: result.usage?.steps ?? maxSteps,
        toolUse: { steps: result.usage?.steps ?? maxSteps, calls: {}, finishCorrections: 0 },
      });
      const problems = await this.validateFinish(ctx, built);
      if (problems.length) throw new Error(`the runtime's finish was rejected: ${problems.join("; ")}`);

      return {
        ...built,
        provenance: {
          ...built.provenance,
          isolation,
          executionEnvironment: `${this.d.runtime.backend}@${caps.isolation}`,
          runtime: { backend: this.d.runtime.backend, image: spec.image, exportedCommit: ingested.commit, protocol: RUNTIME_PROTOCOL },
        },
      };
    } catch (e) {
      await ctx.transcript.record({ role: "note", author: sys, content: `agent runtime failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    } finally {
      try {
        await recordEvents();
      } catch (e) {
        await ctx.transcript.record({ role: "note", author: sys, content: `runtime event read failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      if (issuedToken) {
        try {
          await this.d.modelAccess.revoke(ctx.run.metadata);
        } catch (e) {
          await ctx.transcript.record({ role: "note", author: sys, content: `model token revoke failed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      try {
        await job?.dispose();
      } catch (e) {
        await ctx.transcript.record({ role: "note", author: sys, content: `runtime dispose failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      try {
        await server?.close();
      } catch (e) {
        await ctx.transcript.record({ role: "note", author: sys, content: `control server close failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      try {
        await surface?.close();
      } catch (e) {
        await ctx.transcript.record({ role: "note", author: sys, content: `tool surface close failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  /** Never mask a validator error (post-run checks still apply). */
  private async validateFinish(ctx: ExecutionContext, result: AgentResult): Promise<string[]> {
    if (!this.d.finish) return [];
    try {
      return await this.d.finish.validate(ctx, result);
    } catch (e) {
      await ctx.transcript.record({ role: "note", author: { type: "system", id: "agent-runtime" }, content: `finish validation skipped: ${e instanceof Error ? e.message : String(e)}` });
      return [];
    }
  }
}

/** A run never waits forever: the runtime's own budget is the deadline (the factory kills an expired run in `dispose`). */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
