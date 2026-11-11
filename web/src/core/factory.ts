/**
 * Composition root (AGENTS.md rule 3). The ONLY file that knows concrete implementations.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentToolInfo, Clock, GateCheck, GateEvaluator, LLMClientFactory, OutboxHandler, SkillHandler, SourceConnector } from "./ports/index.ts";
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
import { automatedGate, decisionGate, humanApprovalGate } from "./workflow/gates.ts";
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
import { StoreOutbox, commentHandler, createClarificationSyncController, createOutboxController } from "./runtime/outbox.ts";

export interface FactoryOptions {
  /** Repo root containing agents/, skills/, workflows/, … */
  definitionsRoot: string;
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

  const tools = new Registry<AgentToolInfo>();
  for (const name of ["code-search", "git-read", "filesystem-read"]) tools.register(name, { name, readOnly: true, description: `${name} (read-only)` });

  const skillHandlers = new Registry<SkillHandler>();
  skillHandlers.register(classificationHandler.skill, classificationHandler);
  skillHandlers.register(codebaseResearchHandler.skill, codebaseResearchHandler);

  const workspaces = new LocalWorkspaceProvider(o.definitionsRoot);
  const contexts = new DefaultContextFactory({
    reader: store,
    providers: [codeSearchProvider(workspaces, new RipgrepCodeSearch()), repositoryDocsProvider(workspaces)],
    models,
    recorders,
  });
  const executor = new ExecutorChain([
    new LLMExecutor(new DefaultPromptBuilder(), tools),
    new SkillHandlerExecutor(skillHandlers),
    new SimulatedExecutor(),
  ]);

  // ── workflow & gates ─────────────────────────────────────────────────
  const compiler = new DefaultWorkflowCompiler(store);
  const checks = new Registry<GateCheck>();
  const gates = new Registry<GateEvaluator>();
  for (const g of [decisionGate, humanApprovalGate, automatedGate(checks, events)]) gates.register(g.type, g);

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

  // ── controllers ──────────────────────────────────────────────────────
  const manager = new ControllerManager(store, o.log);
  manager.register(createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates, outbox }));
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
