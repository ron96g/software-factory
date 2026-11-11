/**
 * Composition root (AGENTS.md rule 3). The ONLY file that knows concrete implementations.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { BranchPublisher, CodeHost, AgentTool, Clock, ExecutionEnvironment, WorkspaceCleaner, WorkspacePreparer, WorkspaceSupport, WorkspaceSweeper, GateCheck, GateEvaluator, LLMClientFactory, OutboxHandler, SkillHandler, SourceConnector } from "./ports/index.ts";
import { KindRegistry, Registry } from "./registry/registry.ts";
import { BUILTIN_KINDS } from "./registry/kinds.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { GitDefinitionLoader } from "./store/definition-loader.ts";
import { CompositeStore, DefinitionStore, ScopeRouter } from "./store/composite-store.ts";
import { AdmissionChain, AdmittedStore } from "./admission/chain.ts";
import { nameValidator, namespaceDefaulter, refValidator, requiredFieldsValidator, sourceDefaultsMutator } from "./admission/builtins.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { DefaultRecorderFactory, RedactingSecretResolver, SecretRedactor } from "./transcripts/recorder.ts";
import { EnvSecretResolver } from "./adapters/secrets/env.ts";
import { ControllerManager } from "./runtime/controller-manager.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { decisionGate, humanApprovalGate } from "./workflow/gates.ts";
import { automatedGate } from "./workflow/checks.ts";
import { SandboxCommandRunner } from "./agents/command-runner.ts";
import { GitBranchPublisher } from "./adapters/workspaces/git-publish.ts";
import { GithubCodeHost } from "./adapters/codehosts/github.ts";
import { pullRequestHandler } from "./runtime/publish.ts";
import { createWorkItemController } from "./runtime/controllers/workitem.ts";
import { createAgentRunController } from "./runtime/controllers/agentrun.ts";
import { createApprovalController, createClarificationController } from "./runtime/controllers/human-gates.ts";
import { createConversationController } from "./runtime/controllers/conversation.ts";
import { DefaultContextFactory } from "./agents/context-factory.ts";
import { DefaultPromptBuilder } from "./agents/prompt-builder.ts";
import { ExecutorChain, LLMExecutor, SkillHandlerExecutor } from "./agents/executors.ts";
import { SimulatedExecutor, classificationHandler, codebaseResearchHandler } from "./agents/builtin-skills.ts";
import { codeSearchProvider, repositoryDocsProvider } from "./agents/context-providers.ts";
import { LocalWorkspaceProvider, RipgrepCodeSearch } from "./adapters/codesearch/ripgrep.ts";
import { anthropicFactory, openAICompatibleFactory } from "./adapters/llm/clients.ts";
import { DefaultModelResolver } from "./agents/model-resolver.ts";
import { ExplainResponder } from "./agents/explain-responder.ts";
import { GithubConnector, internalConnector, manualConnector } from "./adapters/sources/connectors.ts";
import { DefaultSourceSyncer } from "./sources/syncer.ts";
import { FactoryApp } from "./app/factory-app.ts";
import { JiraConnector } from "./adapters/sources/jira.ts";
import { DefaultRunReplayer } from "./agents/replayer.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { HostEnvironment } from "./adapters/sandbox/host.ts";
import { GitWorktreeWorkspaces } from "./adapters/workspaces/git-worktree.ts";
import { createWorkspaceController } from "./runtime/controllers/workspace.ts";
import { CONTEXT_TOOLS, SANDBOX_TOOLS } from "./agents/sandbox-tools.ts";
import { ToolLoopExecutor } from "./agents/tool-loop.ts";
import { LocalWorkspaceReaders } from "./adapters/workspaces/local-reader.ts";
import { StoreOutbox, commentHandler, createClarificationSyncController, createOutboxController } from "./runtime/outbox.ts";

/** Composition-root convenience alias; consumers depend on the individual ports. */
type WorkspaceBackend = WorkspacePreparer & WorkspaceCleaner & WorkspaceSupport & WorkspaceSweeper;

export interface FactoryOptions {
  /** Repo root containing agents/, skills/, workflows/, … */
  definitionsRoot: string;
  /** Where the `host` runtime keeps per-item Git worktrees (ADR-0020). Default: next to the database. */
  workspacesDir?: string;
  /** Workspace backend override (ADR-0021), e.g. a fake in tests. Default follows the runtime. */
  workspaceBackend?: WorkspaceBackend;
  /** Publishing overrides (ADR-0023), e.g. fakes in tests. */
  publisher?: BranchPublisher;
  codeHosts?: CodeHost[];
  checkPollMs?: number;
  /** Extra sandbox runtimes (ADR-0019), e.g. a fake in tests. `none` is always registered. */
  sandboxes?: ExecutionEnvironment[];
  /** Poll interval for replies on synced issues (W3). */
  commentPollMs?: number;
  /** SQLite file, or ":memory:". */
  databasePath: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  clock?: Clock;
  log?: (msg: string, err?: unknown) => void;
}

export async function createFactory(o: FactoryOptions) {
  const clock = o.clock ?? { now: () => new Date() };
  if (o.databasePath !== ":memory:") mkdirSync(dirname(o.databasePath), { recursive: true });
  const db = new DatabaseSync(o.databasePath);
  db.exec("PRAGMA journal_mode = WAL");

  // ── store & admission ────────────────────────────────────────────────
  const kinds = new KindRegistry();
  BUILTIN_KINDS.forEach((k) => kinds.register(k));
  const runtime = new SqliteStore(db, clock);
  const definitions = await new DefinitionStore(new GitDefinitionLoader(o.definitionsRoot)).init();
  const composite = new CompositeStore(new ScopeRouter(kinds, definitions, runtime), [definitions, runtime]);
  const admission = new AdmissionChain();
  admission.addMutator(namespaceDefaulter(kinds));
  admission.addMutator(sourceDefaultsMutator());
  admission.addValidator(nameValidator());
  admission.addValidator(refValidator());
  admission.addValidator(requiredFieldsValidator("WorkItem", ["title", "sourceRef"]));
  const store = new AdmittedStore(composite, admission);
  const events = new StoreEventRecorder(store);

  // ── secrets & transcripts ────────────────────────────────────────────
  const redactor = new SecretRedactor();
  const secrets = new RedactingSecretResolver(new EnvSecretResolver(o.env ?? process.env), redactor);
  const transcripts = new SqliteTranscriptStore(db, clock);
  const recorders = new DefaultRecorderFactory(transcripts, redactor);

  // ── models, tools, skills ────────────────────────────────────────────
  const llmFactories = new Registry<LLMClientFactory>();
  llmFactories.register("openai-compatible", openAICompatibleFactory(o.fetch));
  llmFactories.register("anthropic", anthropicFactory(o.fetch));
  const models = new DefaultModelResolver(store, secrets, llmFactories);

  const tools = new Registry<AgentTool>();
  for (const t of [...CONTEXT_TOOLS, ...SANDBOX_TOOLS]) {
    if (t.name === "finish") throw new Error('tool name "finish" is reserved by the tool loop');
    tools.register(t.name, t);
  }

  const skillHandlers = new Registry<SkillHandler>();
  skillHandlers.register(classificationHandler.skill, classificationHandler);
  skillHandlers.register(codebaseResearchHandler.skill, codebaseResearchHandler);

  // ── sandbox runtimes (ADR-0019) ──────────────────────────────────────
  const sandboxEnvs = new Registry<ExecutionEnvironment>();
  sandboxEnvs.register("none", new NoSandboxEnvironment());
  // ADR-0020: registered, but only used when FACTORY_SANDBOX_RUNTIME=host (never part of `auto`).
  sandboxEnvs.register("host", new HostEnvironment());
  for (const e of o.sandboxes ?? []) sandboxEnvs.register(e.runtime, e);
  const env = o.env ?? process.env;
  const environments = new DefaultEnvironmentSelector(sandboxEnvs, env.FACTORY_SANDBOX_RUNTIME, [
    ...(env.KUBERNETES_SERVICE_HOST ? ["kubernetes"] : []),
    "podman",
    "docker",
    "remote",
    ...(o.sandboxes ?? []).map((e) => e.runtime),
  ]);

  // ── workspaces (ADR-0021): backend follows the runtime; isolated runtimes will clone into volumes ──
  const noWorkspaces: WorkspaceBackend = {
    supports: () => false,
    sweep: async () => [],
    prepare: async () => {
      throw new Error("no workspace backend for this runtime");
    },
    remove: async () => {},
  };
  const workspaceBackend =
    o.workspaceBackend ??
    (env.FACTORY_SANDBOX_RUNTIME === "host"
      ? new GitWorktreeWorkspaces({
          definitionsRoot: o.definitionsRoot,
          workspacesDir: o.workspacesDir ?? join(o.databasePath === ":memory:" ? tmpdir() : dirname(o.databasePath), "workspaces"),
        })
      : noWorkspaces);

  const workspaces = new LocalWorkspaceProvider(o.definitionsRoot);
  const contexts = new DefaultContextFactory({
    reader: store,
    providers: [codeSearchProvider(workspaces, new RipgrepCodeSearch()), repositoryDocsProvider(workspaces)],
    models,
    recorders,
    environments,
  });
  const prompts = new DefaultPromptBuilder();
  const executor = new ExecutorChain([
    new ToolLoopExecutor({ reader: store, prompts, tools, environments, readers: new LocalWorkspaceReaders(new RipgrepCodeSearch()) }),
    new LLMExecutor(prompts, tools),
    new SkillHandlerExecutor(skillHandlers),
    new SimulatedExecutor(),
  ]);

  // ── workflow & gates ─────────────────────────────────────────────────
  const compiler = new DefaultWorkflowCompiler(store);
  const checks = new Registry<GateCheck>();
  const gates = new Registry<GateEvaluator>();
  const runner = new SandboxCommandRunner(store, environments);
  for (const g of [decisionGate, humanApprovalGate, automatedGate({ checks, events, reader: store, runner, pollMs: o.checkPollMs })]) {
    gates.register(g.type, g);
  }

  // ── sources & outbox (rule 7) ────────────────────────────────────────
  const connectors = new Registry<SourceConnector>();
  connectors.register("manual", manualConnector);
  connectors.register("internal", internalConnector);
  connectors.register("github", new GithubConnector(secrets, o.fetch));
  connectors.register("jira", new JiraConnector(secrets, o.fetch));
  const outbox = new StoreOutbox(store);
  const outboxHandlers = new Registry<OutboxHandler>();
  const comment = commentHandler(connectors);
  outboxHandlers.register(comment.action, comment);
  const pr = pullRequestHandler({
    reader: store,
    publisher: o.publisher ?? new GitBranchPublisher(secrets),
    codeHosts: o.codeHosts ?? [new GithubCodeHost(secrets, o.fetch)],
  });
  outboxHandlers.register(pr.action, pr);

  // ── controllers ──────────────────────────────────────────────────────
  const manager = new ControllerManager(store, o.log);
  manager.register(createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates, outbox, workspaces: workspaceBackend }));
  manager.register(
    createWorkspaceController({ reader: store, status: store, events, preparer: workspaceBackend, cleaner: workspaceBackend, sweeper: workspaceBackend, redactor }),
  );
  manager.register(createOutboxController({ reader: store, status: store, events, clock, handlers: outboxHandlers, redactor }));
  manager.register(
    createClarificationSyncController({ reader: store, writer: store, events, connectors, pollMs: o.commentPollMs ?? 60_000 }),
  );
  manager.register(createAgentRunController({ reader: store, writer: store, status: store, events, clock, contexts, executor, recorders, redactor }));
  manager.register(createClarificationController({ reader: store, status: store, clock }));
  manager.register(createApprovalController({ reader: store, status: store }));
  manager.register(createConversationController({ reader: store, status: store, recorders }));

  const syncer = new DefaultSourceSyncer({ reader: store, writer: store, connectors, events });

  const app = new FactoryApp({
    reader: store,
    writer: store,
    kinds,
    compiler,
    syncer,
    transcripts,
    replayer: new DefaultRunReplayer(store, store),
    environments,
    models,
    responder: new ExplainResponder({ reader: store, transcripts, recorders, models }),
  });

  return {
    app,
    /** Watch feed for the UI (SSE). */
    watcher: store as Pick<typeof store, "watch">,
    transcriptTail: transcripts as Pick<typeof transcripts, "tail">,
    manager,
    async start() {
      await manager.start();
    },
    async stop() {
      await manager.stop();
      db.close();
    },
  };
}

export type Factory = Awaited<ReturnType<typeof createFactory>>;
