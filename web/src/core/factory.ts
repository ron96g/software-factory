/**
 * Composition root (AGENTS.md rule 3). The ONLY file that knows concrete implementations.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelProvider, ToolServer, Source, Repository } from "./model/kinds.ts";
import { DatabaseSync } from "node:sqlite";
import type { BranchPublisher, CodeHost, ConversationResponder, AgentTool, Clock, ExecutionEnvironment, WorkspaceCleaner, WorkspacePreparer, WorkspaceSupport, WorkspaceSweeper, GateCheck, GateEvaluator, LLMClientFactory, OutboxHandler, SkillHandler, SourceConnector, KnowledgeSourceSearch } from "./ports/index.ts";
import { KindRegistry, Registry } from "./registry/registry.ts";
import { BUILTIN_KINDS } from "./registry/kinds.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { inClusterRest } from "./k8s/rest.ts";
import { RunPins } from "./store/run-pins.ts";
import { K8sLoader } from "./k8s/loader.ts";
import { StatusWriter, inClusterStatus } from "./k8s/status.ts";
import { selectDefinitionLoader } from "./k8s/select.ts";
import { GitDefinitionLoader } from "./store/definition-loader.ts";
import { snapshotAdmit } from "./admission/snapshot.ts";
import { CompositeStore, DefinitionStore, type Admit, ScopeRouter } from "./store/composite-store.ts";
import { AdmissionChain, AdmittedStore } from "./admission/chain.ts";
import { nameValidator, namespaceDefaulter, refValidator, requiredFieldsValidator, sourceDefaultsMutator } from "./admission/builtins.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { DefaultRecorderFactory, RedactingSecretResolver, SecretRedactor } from "./transcripts/recorder.ts";
import { K8sSecretResolver, SecretMissingError, inClusterSecrets } from "./k8s/secrets.ts";
import { EnvSecretResolver } from "./adapters/secrets/env.ts";
import { ControllerManager } from "./runtime/controller-manager.ts";
import { EventingReconcileErrorReporter } from "./runtime/reconcile-errors.ts";
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
import { RequireRealExecutor } from "./agents/execution-gate.ts";
import { McpToolProvider, type McpToolProviderDeps } from "./adapters/mcp/client.ts";
import { createMcpHttpHandler } from "./adapters/mcp/server.ts";
import { factoryTools } from "./exposed/factory-tools.ts";
import { FilesKnowledgeSearch } from "./adapters/knowledge/files.ts";
import { DefaultKnowledgeSearcher } from "./knowledge/searcher.ts";
import { knowledgeProvider } from "./knowledge/context.ts";
import { createKnowledgeController } from "./runtime/controllers/knowledge.ts";
import { KnowledgeRefineResponder } from "./agents/knowledge-refine-responder.ts";
import { codeSearchProvider, repositoryDocsProvider } from "./agents/context-providers.ts";
import { LocalWorkspaceProvider, RipgrepCodeSearch } from "./adapters/codesearch/ripgrep.ts";
import { anthropicFactory, openAICompatibleFactory } from "./adapters/llm/clients.ts";
import { DefaultModelResolver } from "./agents/model-resolver.ts";
import { ExplainResponder } from "./agents/explain-responder.ts";
import { ItemExplainResponder } from "./agents/item-explain-responder.ts";
import { DefaultWorkItemRecordReader } from "./agents/work-item-record.ts";
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
import { DefaultRecordedToolTurns } from "./agents/recorded-tool-turns.ts";
import { AgentChatRunner } from "./agents/agent-chat.ts";
import type { ConversationTurnRunner } from "./ports/index.ts";
import { LocalWorkspaceReaders } from "./adapters/workspaces/local-reader.ts";
import { StoreOutbox, commentHandler, createClarificationSyncController, createOutboxController } from "./runtime/outbox.ts";
import { TicketActions } from "./tickets/actions.ts";
import { CheckActions } from "./checks/actions.ts";
import { checkRunValidator } from "./checks/admission.ts";
import { createCheckRunController } from "./checks/controller.ts";
import { GitWorkspaceSnapshotter } from "./adapters/workspaces/snapshot.ts";
import { GitModuleScopePlanner } from "./adapters/workspaces/module-scope.ts";
import { SandboxCheckRunner } from "./adapters/sandbox/check-runner.ts";
import { WorkflowCheckScheduler } from "./checks/scheduler.ts";
import { registerCheckResultClassifiers } from "./checks/classifiers.ts";
import { VerificationService } from "./verification/service.ts";
import { verificationContext } from "./verification/context.ts";
import type { CheckResultClassifier } from "./ports/index.ts";
import { DEFAULT_NAMESPACE, type Ref } from "./model/resource.ts";
import { ticketHandlers, ticketPublicationGate } from "./tickets/publication.ts";
import type { SourceWritePolicy } from "./ports/index.ts";
import type { RetrospectivePolicy } from "./model/kinds.ts";
import { DefaultFeedbackCapture } from "./retrospectives/capture.ts";
import { createFeedbackCaptureController } from "./retrospectives/capture-controller.ts";
import { DefaultRetrospectiveAggregation } from "./retrospectives/aggregation.ts";
import { DefaultRetrospectiveInvestigator } from "./retrospectives/investigator.ts";
import { createRetrospectiveController } from "./retrospectives/controller.ts";
import { RetrospectiveActions } from "./retrospectives/actions.ts";
import { RetrospectiveReview, retrospectiveContext } from "./retrospectives/review.ts";
import { feedbackDeletionGuard, retrospectiveValidator } from "./retrospectives/admission.ts";
import { DEFAULT_RETROSPECTIVE_POLICY } from "./retrospectives/evidence.ts";

/** Composition-root convenience alias; consumers depend on the individual ports. */
type WorkspaceBackend = WorkspacePreparer & WorkspaceCleaner & WorkspaceSupport & WorkspaceSweeper;

export interface FactoryOptions {
  retrospectivePolicy?: RetrospectivePolicy;
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
  /** Test seam (ADR-0034): transport per ToolServer, e.g. an in-memory pair. */
  mcpTransportFor?: McpToolProviderDeps["transportFor"];
  /** SQLite file, or ":memory:". */
  databasePath: string;
  env?: Record<string, string | undefined>;
  /** Test seam: REST port used by the in-cluster loader. */
  k8sSecretsPort?: import("./k8s/secrets.ts").SecretsPort;
  k8sStatusPort?: import("./k8s/status.ts").StatusPort;
  k8sRest?: import("./k8s/loader.ts").RestPort;
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
  const runtime = new SqliteStore(db, clock, [feedbackDeletionGuard]);
  let defAdmit: Admit | undefined;
  const env0 = o.env ?? process.env;
  const plural = (k: string) => BUILTIN_KINDS.find((b) => b.kind === k)!.plural;
  const statusWriter = env0.KUBERNETES_SERVICE_HOST ? new StatusWriter(o.k8sStatusPort ?? inClusterStatus(env0, plural)) : undefined;
  const defLoader = selectDefinitionLoader(
    o.env ?? process.env,
    () => new GitDefinitionLoader(o.definitionsRoot),
    () => o.k8sRest ?? inClusterRest(o.env ?? process.env),
    {
      onReject: (r, why) => void statusWriter?.rejected(r, why),
      onAccept: (r) => void statusWriter?.accepted(r),
    },
  );
  const isK8s = defLoader instanceof K8sLoader;
  const initialK8s = isK8s ? await defLoader.load() : [];
  const definitions = await new DefinitionStore(isK8s ? { load: async () => [] } : defLoader, (c) => defAdmit?.(c)).init();
  const composite = new CompositeStore(new ScopeRouter(kinds, definitions, runtime), [definitions, runtime]);
  const admission = new AdmissionChain();
  const scopes = new GitModuleScopePlanner();
  admission.addMutator(namespaceDefaulter(kinds));
  admission.addMutator(sourceDefaultsMutator());
  admission.addValidator(nameValidator());
  admission.addValidator(refValidator());
  admission.addValidator(requiredFieldsValidator("WorkItem", ["title", "sourceRef"]));
  admission.addValidator(checkRunValidator(scopes));
  admission.addValidator(retrospectiveValidator());
  defAdmit = snapshotAdmit(admission);
  const store = new AdmittedStore(composite, admission);
  if (isK8s) {
    // Initial list goes through admission: as one bulk candidate, else one by one (invalid ones rejected + Ready=False).
    const bulk = await definitions.bulkApply(initialK8s);
    if (!bulk.ok) {
      let pending = [...initialK8s];
      for (let progress = true; progress && pending.length;) {
        progress = false;
        for (const r of [...pending]) {
          if ((await definitions.apply(r)).ok) { pending = pending.filter((x) => x !== r); progress = true; void statusWriter?.accepted(r); }
        }
      }
      for (const r of pending) void statusWriter?.rejected(r, (await definitions.apply(r)).reason ?? bulk.reason ?? "rejected");
    } else for (const r of initialK8s) void statusWriter?.accepted(r);
    (defLoader as K8sLoader).start(definitions);
  }
  const events = new StoreEventRecorder(store);

  // ── secrets & transcripts ────────────────────────────────────────────
  const redactor = new SecretRedactor();
  const k8sSecrets = defLoader instanceof K8sLoader ? new K8sSecretResolver(o.k8sSecretsPort ?? inClusterSecrets(o.env ?? process.env)) : undefined;
  const secrets = new RedactingSecretResolver(k8sSecrets ?? new EnvSecretResolver(o.env ?? process.env), redactor);
  // Queued chat text is persisted before any model/tool connection resolves its credentials.
  const [providers, servers, sources, repositories] = await Promise.all([
    store.list<ModelProvider>("ModelProvider"), store.list<ToolServer>("ToolServer"),
    store.list<Source>("Source"), store.list<Repository>("Repository"),
  ]);
  const collectRefs = async () => {
    const [pv, sv, so, re] = await Promise.all([
      definitions.list<ModelProvider>("ModelProvider"), definitions.list<ToolServer>("ToolServer"),
      definitions.list<Source>("Source"), definitions.list<Repository>("Repository"),
    ]);
    return [
      ...pv.map((r) => ({ ref: r.spec.secretRef as Ref | undefined, namespace: r.metadata.namespace, owner: r as import("./model/resource.ts").Resource })),
      ...sv.map((r) => ({ ref: r.spec.secretRef as Ref | undefined, namespace: r.metadata.namespace, owner: r as import("./model/resource.ts").Resource })),
      ...so.map((r) => ({ ref: r.spec.connection?.secretRef as Ref | undefined, namespace: r.metadata.namespace, owner: r as import("./model/resource.ts").Resource })),
      ...re.map((r) => ({ ref: r.spec.git?.secretRef as Ref | undefined, namespace: r.metadata.namespace, owner: r as import("./model/resource.ts").Resource })),
    ];
  };
  const refreshSecrets = async () => {
    if (!k8sSecrets) return;
    const rs = await collectRefs();
    try { await k8sSecrets.refresh(rs); } catch (e) {
      if (!(e instanceof SecretMissingError)) throw e;
      // keep last good cache; report Ready=False on the owning CRs (no secret values involved)
      for (const x of rs) if (x.ref?.name === e.secretName && (x.ref.namespace ?? x.namespace ?? "factory-system") === e.namespace) void statusWriter?.missingSecret(x.owner, e.secretName);
    }
  };
  if (k8sSecrets) {
    await refreshSecrets();
    let t: ReturnType<typeof setTimeout> | undefined;
    definitions.watch(() => { clearTimeout(t); t = setTimeout(() => void refreshSecrets().catch(() => {}), 50); }, ["ModelProvider", "ToolServer", "Source", "Repository"]);
  } else for (const { ref } of await collectRefs()) secrets.resolve(ref);
  // Run pinning: pin the definition snapshot while an AgentRun is active; unfinished runs re-pin on restart.
  const runPins = new RunPins(db, definitions);
  runPins.repinAll();
  store.watch((e) => {
    const id = `${e.object.metadata.namespace ?? "default"}/${e.object.metadata.name}`;
    const phase = (e.object as { status?: { phase?: string } }).status?.phase;
    if (e.type === "DELETED" || phase === "Succeeded" || phase === "Failed") runPins.end(id);
    else if (phase === "Running" && runPins.versionOf(id) === undefined) runPins.start(id);
  }, ["AgentRun"]);
  const transcripts = new SqliteTranscriptStore(db, clock);
  const recorders = new DefaultRecorderFactory(transcripts, redactor);
  const feedbackCapture = new DefaultFeedbackCapture(redactor, clock);
  const retrospectiveAggregation = new DefaultRetrospectiveAggregation(store, clock, o.retrospectivePolicy ?? DEFAULT_RETROSPECTIVE_POLICY);
  const retrospectiveReview = new RetrospectiveReview(store);
  const retrospectives = new RetrospectiveActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, aggregation: retrospectiveAggregation, clock, redactor, events });

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
          // Outside the web app, so Next.js/tsc never pick up workspace copies of the code.
          workspacesDir: o.workspacesDir ?? env.FACTORY_WORKSPACES_DIR ?? join(o.definitionsRoot, ".workspaces"),
        })
      : noWorkspaces);

  // ── knowledge base (ADR-0030): search per KnowledgeSource.type; only approved entries are ever returned ──
  const knowledgeSources = new Registry<KnowledgeSourceSearch>();
  const filesKnowledge = new FilesKnowledgeSearch(o.definitionsRoot);
  knowledgeSources.register(filesKnowledge.type, filesKnowledge);
  const knowledge = new DefaultKnowledgeSearcher({ reader: store, sources: knowledgeSources, redactor });

  const workspaces = new LocalWorkspaceProvider(o.definitionsRoot);
  const compiler = new DefaultWorkflowCompiler(store);
  const snapshots = new GitWorkspaceSnapshotter();
  const checkScheduler = new WorkflowCheckScheduler({ reader: store, writer: store, snapshots, environments, redactor, scopes });
  const verification = new VerificationService({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, compiler,
    snapshots, environments, scheduler: checkScheduler, events, clock, redactor });
  const contexts = new DefaultContextFactory({
    reader: store,
    providers: [codeSearchProvider(workspaces, new RipgrepCodeSearch()), repositoryDocsProvider(workspaces), knowledgeProvider(knowledge),
      retrospectiveContext(store, redactor),
      verificationContext({ reader: store, logs: transcripts, compiler, redactor })],
    models,
    recorders,
    environments,
    compiler,
  });
  const prompts = new DefaultPromptBuilder();
  const recordedTurns = new DefaultRecordedToolTurns();
  const toolProvider = new McpToolProvider({ secrets, redactor, fetch: o.fetch, transportFor: o.mcpTransportFor });
  const realExecutors = [
    new ToolLoopExecutor({
      reader: store,
      prompts,
      tools,
      environments,
      readers: new LocalWorkspaceReaders(new RipgrepCodeSearch()),
      knowledge,
      toolProvider,
      turns: recordedTurns,
      checks: verification,
    }),
    new LLMExecutor(prompts, tools),
    new SkillHandlerExecutor(skillHandlers),
  ];
  const executor = new ExecutorChain([...realExecutors, new SimulatedExecutor()]);
  // ADR-0029: `allow` (default) falls back to simulated output; `wait` keeps runs Pending until a real executor fits.
  const simulation = env.FACTORY_SIMULATION ?? "allow";
  if (simulation !== "allow" && simulation !== "wait") throw new Error(`FACTORY_SIMULATION must be "allow" or "wait", got "${simulation}"`);
  const executionGate = simulation === "wait" ? new RequireRealExecutor(realExecutors) : undefined;

  // ── workflow & gates ─────────────────────────────────────────────────
  const checks = new Registry<GateCheck>();
  const gates = new Registry<GateEvaluator>();
  const runner = new SandboxCommandRunner(store, environments);
  for (const g of [decisionGate, humanApprovalGate, automatedGate({ checks, events, reader: store, runner, redactor, scopes, pollMs: o.checkPollMs })]) {
    gates.register(g.type, g);
  }
  for (const gate of verification.gates) gates.register(gate.type, gate);
  gates.register(retrospectiveReview.type, retrospectiveReview);

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
  for (const handler of ticketHandlers({ reader: store, connectors, redactor })) outboxHandlers.register(handler.action, handler);
  const sourcePolicies = new Registry<SourceWritePolicy>();
  sourcePolicies.register("comment", { check: (s) => s.spec.sync?.bidirectional ? undefined : "read-only (sync.bidirectional is not true)" });
  sourcePolicies.register("service-desk-reply", { check: (s) => Array.isArray(s.spec.writeBack?.replyVisibilities) && s.spec.writeBack.replyVisibilities.length ? undefined : "reviewed replies are not permitted" });
  sourcePolicies.register("ticket-transition", { check: (s) => s.spec.writeBack?.transitions === true ? undefined : "ticket transitions are not permitted" });
  const publicationGate = ticketPublicationGate({ reader: store, outbox, redactor });
  gates.register(publicationGate.type, publicationGate);

  // ── controllers ──────────────────────────────────────────────────────
  const reconcileErrors = new EventingReconcileErrorReporter({ reader: store, events, redactor, clock });
  const manager = new ControllerManager(store, o.log, reconcileErrors);
  manager.register(createFeedbackCaptureController({ reader: store, writer: store, redactor }));
  manager.register(createRetrospectiveController(store, new DefaultRetrospectiveInvestigator({
    reader: store, writer: store, status: store, aggregation: retrospectiveAggregation, clock,
  }), events, redactor));
  const classifiers = new Registry<CheckResultClassifier>();
  registerCheckResultClassifiers(classifiers);
  const checkRuns = new CheckActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store,
    transcripts, snapshots, environments, redactor, scopes });
  const checkRunController = createCheckRunController({ reader: store, status: store, logs: transcripts,
    runner: new SandboxCheckRunner(store, environments), snapshots, clock, events, redactor, classifiers, scopes,
    contracts: verification, onError: (message) => (o.log ?? console.error)(`[checkrun] ${message}`) });
  manager.register(checkRunController);
  manager.register(createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates, outbox, workspaces: workspaceBackend,
    stagePolicy: verification, resumptionPolicy: verification, publicationGuard: verification }));
  manager.register(
    createWorkspaceController({ reader: store, status: store, events, preparer: workspaceBackend, cleaner: workspaceBackend, sweeper: workspaceBackend, redactor }),
  );
  manager.register(createOutboxController({ reader: store, status: store, events, clock, handlers: outboxHandlers, redactor, policies: sourcePolicies }));
  manager.register(
    createClarificationSyncController({ reader: store, writer: store, events, connectors, pollMs: o.commentPollMs ?? 60_000 }),
  );
  const agentRunController = createAgentRunController({
    reader: store, writer: store, status: store, events, clock, contexts, executor, recorders, redactor,
    feedback: feedbackCapture,
    gate: executionGate && { policy: executionGate, previews: contexts },
    onError: (message) => (o.log ?? console.error)(`[agentrun] ${message}`),
  });
  manager.register(agentRunController);
  manager.register(createClarificationController({ reader: store, status: store, clock }));
  manager.register(createApprovalController({ reader: store, status: store }));
  const conversationTurns = new Registry<ConversationTurnRunner>();
  const itemRecords = new DefaultWorkItemRecordReader(store);
  const tickets = new TicketActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, connectors, outbox, clock, redactor, compiler, records: itemRecords, events });
  conversationTurns.register("agent-chat", new AgentChatRunner({ reader: store, transcripts, models, tools: toolProvider, turns: recordedTurns, environments, redactor, records: itemRecords }));
  const conversationController = createConversationController({
    reader: store, status: store, recorders, transcripts, turns: conversationTurns, clock, redactor, events,
    onError: (message) => (o.log ?? console.error)(`[conversation] ${message}`),
  });
  manager.register(conversationController);
  manager.register(createKnowledgeController({ reader: store, status: store, events, clock }));

  const syncer = new DefaultSourceSyncer({ reader: store, writer: store, connectors, events });

  const responders = new Registry<ConversationResponder>();
  responders.register("explain", new ExplainResponder({ reader: store, transcripts, recorders, models }));
  responders.register("explain-item", new ItemExplainResponder({ records: itemRecords, transcripts, recorders, models, redactor }));
  responders.register("refine-knowledge", new KnowledgeRefineResponder({ reader: store, transcripts, recorders, models, redactor }));

  const app = new FactoryApp({
    approvalGuards: [retrospectiveReview],
    verificationGuard: verification,
    reader: store,
    writer: store,
    kinds,
    compiler,
    syncer,
    transcripts,
    replayer: new DefaultRunReplayer(store, store),
    environments,
    models,
    controllerHealth: reconcileErrors,
    events,
    responders,
    simulation,
    redactor,
    records: itemRecords,
    clock,
  });

  // ── MCP server (ADR-0034): what local agent harnesses may do; gates stay in the UI ──
  const exposedTools = factoryTools({ items: app, answers: app, sources: app, knowledge: app, search: knowledge });
  const mcp = createMcpHttpHandler({
    tools: () => exposedTools,
    token: secrets.resolve({ name: "factory-mcp-token" }),
    redactor,
  });

  return {
    app,
    tickets,
    checkRuns,
    retrospectives,
    verification,
    /** Streamable HTTP MCP endpoint handler (Request → Response). */
    mcp,
    /** The exposed tool catalog (also used by tests). */
    exposedTools,
    /** Watch feed for the UI (SSE). */
    watcher: store as Pick<typeof store, "watch">,
    transcriptTail: transcripts as Pick<typeof transcripts, "tail">,
    manager,
    async start() {
      await manager.start();
    },
    async stop() {
      await manager.stop();
      await Promise.all([agentRunController.stop(), conversationController.stop(), checkRunController.stop()]);
      db.close();
    },
  };
}

export type Factory = Awaited<ReturnType<typeof createFactory>>;
