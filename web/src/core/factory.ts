/**
 * Composition root (AGENTS.md rule 3). The ONLY file that knows concrete implementations.
 */
import { CREATE_ISSUE_ACTION, createIssuePolicy } from "./issues/policy.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ModelProvider, ToolServer, Source, Repository, ArtifactType, SandboxProfile } from "./model/kinds.ts";
import { nsOf } from "./model/meta.ts";
import { resolveRef } from "./refs/refs.ts";
import { DatabaseSync } from "node:sqlite";
import type { DefinitionFeed, NamespacedSecretReader, SecretWatcher, SecretResolver, BaseConflictDetector, BranchPublisher, CodeHost, WorkspaceIntegrator, ConversationResponder, AgentTool, Clock, ExecutionEnvironment, WorkspaceCleaner, WorkspacePreparer, WorkspaceSupport, WorkspaceSweeper, ArtifactCheck, ProposedArtifactCheck, GateCheck, GateEvaluator, LLMClientFactory, OutboxHandler, SkillHandler, SourceConnector, KnowledgeSourceSearch, ResourceWatcher, AgentProcessKiller, ToolProvisioner, CommitHookSetup, CommitMessageConvention } from "./ports/index.ts";
import { KindRegistry, Registry } from "./registry/registry.ts";
import { BUILTIN_KINDS } from "./registry/kinds.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { SqliteChangeFeed } from "./store/change-feed.ts";
import { SqliteWorkspaceLock } from "./store/workspace-lock.ts";
import { SqliteFencedStatusWriter } from "./store/fenced-status.ts";
import { FeedWatcher } from "./store/feed-watcher.ts";
import { NoProcessKiller, incarnationId, reapStaleIncarnations } from "./runtime/incarnations.ts";
import { WORKER_LEASE_PREFIX, WorkerHeartbeat } from "./runtime/worker-heartbeat.ts";
import { GitDefinitionLoader } from "./store/definition-loader.ts";
import { BUILTIN_CAPABILITY_DETECTORS } from "./capabilities/detectors.ts";
import { CompositeStore, ScopeRouter } from "./store/composite-store.ts";
import { ReloadingDefinitionStore, refSnapshotValidator } from "./store/reloading-store.ts";
import { AdmissionChain, AdmittedStore } from "./admission/chain.ts";
import { nameValidator, namespaceDefaulter, recoveryPolicyValidator, refValidator, requiredFieldsValidator, sourceDefaultsMutator } from "./admission/builtins.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { DefaultRecorderFactory, RedactingSecretResolver, SecretRedactor } from "./transcripts/recorder.ts";
import { EnvSecretResolver } from "./adapters/secrets/env.ts";
import { NamespacedSecretResolver } from "./adapters/secrets/namespaced.ts";
import { describeProxy, ensureProxyDispatcher } from "./adapters/http/proxy.ts";
import { KubeClusterApi } from "./adapters/kubernetes/cluster-api.ts";
import { KubeSecretReader, KubeSecretWatcher } from "./adapters/kubernetes/secret-reader.ts";
import { ControllerManager } from "./runtime/controller-manager.ts";
import { EventingReconcileErrorReporter } from "./runtime/reconcile-errors.ts";
import { DefaultWorkflowCompiler } from "./workflow/compiler.ts";
import { decisionGate, humanApprovalGate } from "./workflow/gates.ts";
import { automatedGate } from "./workflow/checks.ts";
import { SandboxCommandRunner } from "./agents/command-runner.ts";
import { GitBranchPublisher } from "./adapters/workspaces/git-publish.ts";
import { SandboxCandidateCommitter } from "./adapters/sandbox/candidate-committer.ts";
import { PRE_COMMIT_HOOKS } from "./adapters/sandbox/candidate-commit.ts";
import { conventionalCommits } from "./runtime/commit-message.ts";
import { GitBaseSync } from "./adapters/workspaces/git-base-sync.ts";
import { GitBundleIngest, GitCandidateDiffer } from "./adapters/workspaces/git-export.ts";
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
import { knowledgeProvider, scopedSearcher } from "./knowledge/context.ts";
import { mirrorLinkChecker } from "./issues/mirror.ts";
import { createIssueHandler, createIssueLinkHandler } from "./issues/handler.ts";
import { createIssueProposalController } from "./issues/controller.ts";
import { createKnowledgeController } from "./runtime/controllers/knowledge.ts";
import { KnowledgeRefineResponder } from "./agents/knowledge-refine-responder.ts";
import { ProductOwnerTicketDrafter } from "./issues/ticket-drafter.ts";
import { storyPublisher } from "./issues/story-publisher.ts";
import { EventFlakyTestReporter } from "./issues/flaky-tests.ts";
import { baseConflictProvider, codeSearchProvider, repositoryDocsProvider } from "./agents/context-providers.ts";
import { LocalWorkspaceProvider, RipgrepCodeSearch } from "./adapters/codesearch/ripgrep.ts";
import { anthropicFactory, googleFactory, openAICompatibleFactory } from "./adapters/llm/clients.ts";
import { DefaultModelResolver } from "./agents/model-resolver.ts";
import { DefaultModelProxy } from "./agents/model-proxy.ts";
import { InMemoryModelTokens } from "./adapters/model-proxy/tokens.ts";
import { createModelProxyHttpHandler } from "./adapters/model-proxy/http.ts";
import { DefaultRuntimeModelAccess } from "./adapters/model-proxy/runtime-access.ts";
import { TranscriptMetrics } from "./metrics/transcript-metrics.ts";
import { DefaultModelPricing, type PriceSchedule } from "./metrics/pricing.ts";
import { PrometheusMetricsExporter } from "./metrics/prometheus.ts";
import { DefaultEgressProxy } from "./adapters/egress/proxy.ts";
import { fetchUrlTool } from "./agents/egress-tool.ts";
import { ExplainResponder } from "./agents/explain-responder.ts";
import { ItemExplainResponder } from "./agents/item-explain-responder.ts";
import { DefaultWorkItemRecordReader } from "./agents/work-item-record.ts";
import { GithubConnector, GithubPullRequestConnector, internalConnector, manualConnector } from "./adapters/sources/connectors.ts";
import { PR_REVIEW_ACTION, PR_REVIEW_REPORT, prReviewReportReader, prReviewArtifactCheck, prReviewHandler, prReviewPolicy, prReviewPublisher } from "./reviews/pr-review.ts";
import { ChangeReviewService } from "./reviews/change-review.ts";
import { CODE_REVIEW_REPORT, codeReviewReportReader, simulatedCodeReviewReport } from "./reviews/code-review-report.ts";
import { followUpOriginResolver } from "./issues/origin.ts";
import { DefaultSourceSyncer } from "./sources/syncer.ts";
import { FactoryApp } from "./app/factory-app.ts";
import { JiraConnector } from "./adapters/sources/jira.ts";
import { DefaultRunReplayer } from "./agents/replayer.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { BwrapEnvironment } from "./adapters/sandbox/bwrap.ts";
import { GitWorktreeWorkspaces } from "./adapters/workspaces/git-worktree.ts";
import { COMMAND_TYPE, DefaultToolchain, GO_INSTALL_TYPE, commandProvisioner, goInstallProvisioner } from "./adapters/toolchain/toolchain.ts";
import { createWorkspaceController } from "./runtime/controllers/workspace.ts";
import { CONTEXT_TOOLS, SANDBOX_TOOLS } from "./agents/sandbox-tools.ts";
import { ToolLoopExecutor } from "./agents/tool-loop.ts";
import { AgentRuntimeExecutor } from "./agents/agent-runtime-executor.ts";
import { DefaultAgentRuntimeSelector } from "./agents/agent-runtime-selector.ts";
import { BwrapAgentRuntime } from "./adapters/runtime/bwrap.ts";
import { createRunControlServerFactory } from "./adapters/runtime/control.ts";
import { bindEgress } from "./agents/run-harness.ts";
import { OpenCodeHost } from "./adapters/opencode/host.ts";
import { OpenCodeExecutor } from "./adapters/opencode/executor.ts";
import { DefaultRecordedToolTurns } from "./agents/recorded-tool-turns.ts";
import { AgentChatRunner } from "./agents/agent-chat.ts";
import type { AgentRuntime, CapabilityDetector, ConversationTurnRunner, DefinitionLoader, ExecutionContext, FinishValidator, StagePublisher, ToolCapabilities, WorkspaceProbe } from "./ports/index.ts";
import { LocalWorkspaceReaders } from "./adapters/workspaces/local-reader.ts";
import { StoreOutbox, commentHandler, createClarificationSyncController, createOutboxController } from "./runtime/outbox.ts";
import { TicketActions } from "./tickets/actions.ts";
import { CheckActions } from "./checks/actions.ts";
import { checkRunValidator } from "./checks/admission.ts";
import { issueProposalValidator } from "./issues/admission.ts";
import { createCheckRunController } from "./checks/controller.ts";
import { GitWorkspaceCheckpoint, GitWorkspaceSnapshotter } from "./adapters/workspaces/snapshot.ts";
import { GitCandidateChanges, GitCandidateDiff, GitModuleScopePlanner, GitWorkingTreeDiff } from "./adapters/workspaces/module-scope.ts";
import { DEFAULT_CHECK_OUTPUT_BYTES, SandboxCheckRunner } from "./adapters/sandbox/check-runner.ts";
import { WorkflowCheckScheduler } from "./checks/scheduler.ts";
import { registerCheckResultClassifiers } from "./checks/classifiers.ts";
import { VerificationService } from "./verification/service.ts";
import { verificationContext } from "./verification/context.ts";
import type { CheckResultClassifier } from "./ports/index.ts";
import { DEFAULT_NAMESPACE } from "./model/resource.ts";
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
import { PlanningService } from "./planning/service.ts";
import { StoreDraftFeedbackBatch } from "./app/feedback-batch.ts";
import { outputFeedbackContext } from "./agents/output-feedback.ts";
import { planningContext } from "./planning/context.ts";
import { planningReview } from "./planning/review.ts";
import { UnitExecutionService } from "./units/service.ts";
import { unitContext } from "./units/context.ts";
import { CompletedUnitAttempts } from "./units/history.ts";
import { ValidatedRecoveryRouter } from "./recovery/router.ts";
import { recoveryContext } from "./recovery/context.ts";
import { RecoveryAllowances } from "./recovery/allowances.ts";
import { DefaultRecoveryCheckAuthorization } from "./recovery/check-authorization.ts";
import { runtimeRecoveryNeed } from "./recovery/runtime-need.ts";
import { StoreWorkspaceJobs } from "./checks/workspace-jobs.ts";
import { ActiveCheckFinishValidator } from "./checks/finish-guard.ts";
import type { RecoveryCheckAuthorization, RecoveryNeedHandler } from "./ports/index.ts";
import type { NotificationClassifier, NotificationQueries, NotificationRule } from "./ports/index.ts";
import { EventNotificationFeed, RuleBasedNotificationClassifier } from "./notifications/classifier.ts";
import { registerNotificationRules } from "./notifications/rules.ts";
import { FeedDefinitionLoader, GitDefinitionFeed, KubernetesDefinitionFeed, definitionsBackend } from "./store/definition-feed.ts";
import { AjvSchemaValidator } from "./adapters/schema/ajv.ts";
import { DefinitionArtifactSchemas } from "./artifacts/schemas.ts";
import { persistedArtifactCheck, RegistryFinishValidator, schemaArtifactCheck } from "./artifacts/output-checks.ts";
import { citedCodeContext } from "./agents/cited-code.ts";
import { artifactSchemaContext } from "./artifacts/context.ts";

/** Composition-root convenience alias; consumers depend on the individual ports. */
type WorkspaceBackend = WorkspacePreparer & WorkspaceCleaner & WorkspaceSupport & WorkspaceSweeper;

export interface FactoryOptions {
  retrospectivePolicy?: RetrospectivePolicy;
  /** ADR-0062 §3: which controllers this process registers. Default "all" (single process). */
  role?: "all" | "web" | "worker";
  /** ADR-0062 §2: kills a previous incarnation's agent processes before its workspace locks are released. */
  processKiller?: AgentProcessKiller;
  /** Repo root containing agents/, skills/, workflows/, … Required for git mode only. */
  definitionsRoot?: string;
  /** Definition source override for git mode, e.g. repository definitions plus test fixtures. */
  definitionLoader?: DefinitionLoader;
  /** Directory for workspaces and file knowledge (AC-7). Default: `FACTORY_LOCAL_ROOT`, else the definitions root. */
  localRoot?: string;
  /** Definition origin override (e.g. a fake cluster feed). Without it, `FACTORY_DEFINITION_SOURCE=git|kubernetes` selects; default git. */
  definitionFeed?: DefinitionFeed;
  /** Secret source for kubernetes mode (tests); default reads `FACTORY_SECRET_NAMESPACE` from the cluster. */
  secretReader?: NamespacedSecretReader;
  /** Secret change stream for kubernetes mode (tests); default watches `FACTORY_SECRET_NAMESPACE`. */
  secretWatcher?: SecretWatcher;
  /** Where the workspace backend keeps per-item Git worktrees (ADR-0021). Default: next to the database. */
  workspacesDir?: string;
  /** Workspace backend override (ADR-0021), e.g. a fake in tests. Default follows the runtime. */
  workspaceBackend?: WorkspaceBackend;
  /** Publishing overrides (ADR-0023), e.g. fakes in tests. */
  publisher?: BranchPublisher;
  codeHosts?: CodeHost[];
  /** ADR-0053 override: base-branch conflict detection + workspace merge. Default: git, for every runtime. Required with `publisher`. */
  baseSync?: BaseConflictDetector & WorkspaceIntegrator;
  checkPollMs?: number;
  /** Extra sandbox runtimes (ADR-0019), e.g. a fake in tests. `none` is always registered. */
  sandboxes?: ExecutionEnvironment[];
  /** Test seam (ADR-0080 §2): `AgentRuntime` backends. Empty in production until a real backend exists (S2-b). */
  agentRuntimes?: AgentRuntime[];
  /** Poll interval for replies on synced issues (W3). */
  commentPollMs?: number;
  /** Test seam (ADR-0034): transport per ToolServer, e.g. an in-memory pair. */
  mcpTransportFor?: McpToolProviderDeps["transportFor"];
  /** SQLite file, or ":memory:". */
  databasePath: string;
  /** OpenCode agent runtime state (ADR-0060). Default: next to the database (a temp dir for ":memory:"). */
  agentRuntimeDir?: string;
  /** ADR-0088 toolchain cache. Default: next to the database (a temp dir for ":memory:"), or `FACTORY_TOOLCHAIN_DIR`. */
  toolchainDir?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  clock?: Clock;
  log?: (msg: string, err?: unknown) => void;
}

export async function createFactory(o: FactoryOptions) {
  // Before anything can make a request: otherwise outbound fetch may bypass HTTPS_PROXY (see adapters/http/proxy.ts).
  if (!o.fetch) ensureProxyDispatcher();
  const clock = o.clock ?? { now: () => new Date() };
  if (o.databasePath !== ":memory:") mkdirSync(dirname(o.databasePath), { recursive: true });
  const db = new DatabaseSync(o.databasePath);
  db.exec("PRAGMA journal_mode = WAL");

  // ── store & admission ────────────────────────────────────────────────
  const kinds = new KindRegistry();
  BUILTIN_KINDS.forEach((k) => kinds.register(k));
  const runtime = new SqliteStore(db, clock, [feedbackDeletionGuard]);
  const changeFeed = new SqliteChangeFeed(db);
  const workspaceLock = new SqliteWorkspaceLock(db, clock);
  const definitionSource = definitionsBackend(o.env ?? process.env);
  if (definitionSource === "git" && !o.definitionFeed && !o.definitionLoader && !o.definitionsRoot) throw new Error("definitionsRoot is required in git mode");
  const localRoot = o.localRoot ?? (o.env ?? process.env).FACTORY_LOCAL_ROOT ?? o.definitionsRoot;
  if (!localRoot) throw new Error("FACTORY_LOCAL_ROOT (or localRoot) is required without a definitions root");
  const definitionFeed =
    o.definitionFeed ??
    (definitionSource === "kubernetes"
      ? new KubernetesDefinitionFeed(new KubeClusterApi())
      : new GitDefinitionFeed(o.definitionLoader ?? new GitDefinitionLoader(o.definitionsRoot!)));
  let rejectDefinitions: (reason: string) => void = () => {};
  const definitions = await new ReloadingDefinitionStore({
    feed: definitionFeed,
    validator: refSnapshotValidator([refValidator()]),
    onRejected: (reason) => rejectDefinitions(reason),
    log: o.log,
  }).init();
  // ADR-0062 §3: when this process loaded its definitions (used to tell "worker is older" from "the check is stale").
  const definitionsLoadedAt = clock.now().toISOString();
  const composite = new CompositeStore(new ScopeRouter(kinds, definitions, runtime), [definitions, runtime]);
  const admission = new AdmissionChain();
  const scopes = new GitModuleScopePlanner();
  let recoveryChecks!: RecoveryCheckAuthorization;
  const recoveryCheckPort: RecoveryCheckAuthorization = { authorize: (input) => recoveryChecks.authorize(input) };
  admission.addMutator(namespaceDefaulter(kinds));
  admission.addMutator(sourceDefaultsMutator());
  admission.addValidator(nameValidator());
  admission.addValidator(recoveryPolicyValidator());
  admission.addValidator(refValidator());
  admission.addValidator(requiredFieldsValidator("WorkItem", ["title", "sourceRef"]));
  admission.addValidator(checkRunValidator(scopes, recoveryCheckPort));
  admission.addValidator(retrospectiveValidator());
  admission.addValidator(issueProposalValidator());
  const store = new AdmittedStore(composite, admission);
  const events = new StoreEventRecorder(store);
  rejectDefinitions = (reason) => {
    o.log?.(`definitions: ${reason}`);
    const involved = { apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "DefinitionSnapshot", metadata: { name: "definitions", namespace: "factory-system", uid: "def-snapshot" }, spec: {} };
    void events.warning(involved as never, "DefinitionsRejected", reason).catch((err) => o.log?.("could not record DefinitionsRejected", err));
  };

  // ── secrets & transcripts ────────────────────────────────────────────
  const redactor = new SecretRedactor();
  let inner: SecretResolver = new EnvSecretResolver(o.env ?? process.env);
  let secretRefresh: NamespacedSecretResolver | undefined;
  if (definitionSource === "kubernetes") {
    const secretNamespace = (o.env ?? process.env).FACTORY_SECRET_NAMESPACE;
    if (!secretNamespace) throw new Error("FACTORY_SECRET_NAMESPACE is required in kubernetes mode");
    secretRefresh = new NamespacedSecretResolver(o.secretReader ?? new KubeSecretReader(), secretNamespace);
    await secretRefresh.refresh();
    const relistMs = Number((o.env ?? process.env).FACTORY_SECRET_RELIST_MS) || undefined;
    secretRefresh.start({ watcher: o.secretWatcher ?? (o.secretReader ? undefined : new KubeSecretWatcher()), relistMs, log: o.log });
    inner = secretRefresh;
  }
  const secrets = new RedactingSecretResolver(inner, redactor);
  // Queued chat text is persisted before any model/tool connection resolves its credentials.
  const preResolveSecrets = async () => {
    const [providers, servers, sources, repositories] = await Promise.all([
      store.list<ModelProvider>("ModelProvider"), store.list<ToolServer>("ToolServer"),
      store.list<Source>("Source"), store.list<Repository>("Repository"),
    ]);
    for (const ref of [
      ...providers.map((r) => r.spec.secretRef), ...servers.map((r) => r.spec.secretRef),
      ...sources.map((r) => r.spec.connection?.secretRef), ...repositories.map((r) => r.spec.git?.secretRef),
    ]) secrets.resolve(ref);
  };
  await preResolveSecrets();
  const transcripts = new SqliteTranscriptStore(db, clock);
  const recorders = new DefaultRecorderFactory(transcripts, redactor);
  const feedbackCapture = new DefaultFeedbackCapture(redactor, clock);
  const retrospectiveAggregation = new DefaultRetrospectiveAggregation(store, clock, o.retrospectivePolicy ?? DEFAULT_RETROSPECTIVE_POLICY);
  const retrospectiveReview = new RetrospectiveReview(store);
  const retrospectives = new RetrospectiveActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, aggregation: retrospectiveAggregation, clock, redactor, events });
  // ADR-0082: factory metrics derived from transcripts and resources. The price schedule is optional and comes from
  // configuration — with none, cost is omitted, never guessed.
  const metrics = new TranscriptMetrics({ reader: store, transcripts, pricing: new DefaultModelPricing(parsePriceSchedule((o.env ?? process.env).FACTORY_MODEL_PRICES)), namespace: DEFAULT_NAMESPACE });
  const metricsExport = new PrometheusMetricsExporter(metrics);

  // ── models, tools, skills ────────────────────────────────────────────
  const llmFactories = new Registry<LLMClientFactory>();
  llmFactories.register("openai-compatible", openAICompatibleFactory(o.fetch));
  llmFactories.register("anthropic", anthropicFactory(o.fetch));
  llmFactories.register("google", googleFactory(o.fetch));
  const models = new DefaultModelResolver(store, secrets, llmFactories);
  // ADR-0080 §4: the factory's model proxy (X60). A runtime holds a run-scoped token, never a provider key.
  const modelTokens = new InMemoryModelTokens(() => clock.now());
  const modelProxy = createModelProxyHttpHandler({ proxy: new DefaultModelProxy({ tokens: modelTokens, models, fetch: o.fetch }) });

  const tools = new Registry<AgentTool>();
  for (const t of [...CONTEXT_TOOLS, ...SANDBOX_TOOLS, fetchUrlTool]) {
    if (t.name === "finish") throw new Error('tool name "finish" is reserved by the tool loop');
    tools.register(t.name, t);
  }

  const skillHandlers = new Registry<SkillHandler>();
  skillHandlers.register(classificationHandler.skill, classificationHandler);
  skillHandlers.register(codebaseResearchHandler.skill, codebaseResearchHandler);

  // ── sandbox runtimes (ADR-0019, ADR-0079) ────────────────────────────
  const env = o.env ?? process.env;
  // ADR-0080 §10: no execution without a primitive. `host` is removed as a runtime; naming it fails loudly instead
  // of falling back silently (ADR-0020 is superseded).
  if ((env.FACTORY_SANDBOX_RUNTIME ?? "").trim().toLowerCase() === "host") {
    throw new Error('FACTORY_SANDBOX_RUNTIME=host is no longer supported: the unsandboxed `host` runtime was removed (ADR-0080 §10). Use "bwrap" locally, or "kubernetes" in a cluster once available; without either, runs simulate or wait (ADR-0029).');
  }
  // ADR-0062 §2/§3: this process's role and incarnation (the identity it holds workspace locks under).
  const role = o.role ?? env.FACTORY_ROLE ?? "all";
  if (role !== "all" && role !== "web" && role !== "worker") throw new Error(`FACTORY_ROLE must be "web", "worker" or "all", got "${role}"`);
  const incarnation = incarnationId(role, env);
  // ADR-0080 §7 / SEC-5: agent-initiated HTTP goes through the egress proxy (host allowlist + transcript audit).
  const egress = new DefaultEgressProxy({ policy: { allow: (env.FACTORY_EGRESS_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean) }, fetch: o.fetch });
  // ADR-0088: the toolchain cache belongs to the store, exactly like the workspaces directory: an in-memory store gets
  // a throwaway directory, and a real store keeps it next to its database.
  const ownedToolchainDir = o.databasePath === ":memory:" && !o.toolchainDir && !env.FACTORY_TOOLCHAIN_DIR
    ? mkdtempSync(join(tmpdir(), "factory-toolchain-"))
    : undefined;
  const toolchainDir = o.toolchainDir ?? env.FACTORY_TOOLCHAIN_DIR ?? ownedToolchainDir ?? join(dirname(o.databasePath), "toolchain");
  const toolProvisioners = new Registry<ToolProvisioner>();
  toolProvisioners.register(GO_INSTALL_TYPE, goInstallProvisioner);
  toolProvisioners.register(COMMAND_TYPE, commandProvisioner);
  const toolchain = new DefaultToolchain({ dir: toolchainDir, provisioners: toolProvisioners });
  // ADR-0092: hook setups a repository may opt into for its publication commit.
  const commitHooks = new Registry<CommitHookSetup>();
  commitHooks.register(PRE_COMMIT_HOOKS.type, PRE_COMMIT_HOOKS);
  const sandboxEnvs = new Registry<ExecutionEnvironment>();
  sandboxEnvs.register("none", new NoSandboxEnvironment());
  // ADR-0079: Linux bubblewrap process/filesystem isolation (ADR-0080 §11: the profile, not the env, decides isolation).
  sandboxEnvs.register("bwrap", new BwrapEnvironment({
    extraRoBinds: env.FACTORY_BWRAP_RO_BINDS?.split(":").filter(Boolean),
    toolchainDir,
    toolchain,
    commitHooks,
  }));
  for (const e of o.sandboxes ?? []) sandboxEnvs.register(e.runtime, e);
  const environments = new DefaultEnvironmentSelector(sandboxEnvs, env.FACTORY_SANDBOX_RUNTIME, [
    ...(env.KUBERNETES_SERVICE_HOST ? ["kubernetes"] : []),
    "podman",
    "docker",
    "remote",
    "bwrap",
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
  const usesWorktrees =
    env.FACTORY_SANDBOX_RUNTIME === "bwrap" ||
    ((!env.FACTORY_SANDBOX_RUNTIME || env.FACTORY_SANDBOX_RUNTIME === "auto") && (await environments.select()).health.runtime === "bwrap");
  // ADR-0021: the workspaces directory belongs to the **store**, like the OpenCode state above: an in-memory store gets
  // a throwaway directory. Sharing `<root>/.workspaces` would let a short-lived instance (a test booting a factory)
  // sweep away every workspace the running factory still owns, because its own store knows none of them.
  const ownedWorkspacesDir = o.databasePath === ":memory:" && !o.workspacesDir && !env.FACTORY_WORKSPACES_DIR
    ? mkdtempSync(join(tmpdir(), "factory-workspaces-"))
    : undefined;
  const workspacesDir = o.workspacesDir ?? env.FACTORY_WORKSPACES_DIR ?? ownedWorkspacesDir ?? join(localRoot, ".workspaces");
  const workspaceBackend =
    o.workspaceBackend ??
    (usesWorktrees
      ? new GitWorktreeWorkspaces({
          definitionsRoot: localRoot,
          // Outside the web app, so Next.js/tsc never pick up workspace copies of the code.
          workspacesDir,
          // ADR-0021 addendum: clone the repository when the declared checkout is absent.
          secrets,
        })
      : noWorkspaces);

  // ── knowledge base (ADR-0030): search per KnowledgeSource.type; only approved entries are ever returned ──
  const knowledgeSources = new Registry<KnowledgeSourceSearch>();
  const filesKnowledge = new FilesKnowledgeSearch(localRoot);
  knowledgeSources.register(filesKnowledge.type, filesKnowledge);
  const knowledge = new DefaultKnowledgeSearcher({ reader: store, sources: knowledgeSources, redactor });

  const workspaces = new LocalWorkspaceProvider(localRoot);
  const compiler = new DefaultWorkflowCompiler(store);
  const snapshots = new GitWorkspaceSnapshotter();
  const jobs = new StoreWorkspaceJobs({ reader: store, lock: workspaceLock, holder: incarnation });
  // ADR-0062 §3: a process that can execute checks announces itself, so "no check worker" means nobody will run them
  // rather than "no check is running right now" (a check lease only exists while a check executes).
  const heartbeat = role === "web"
    ? undefined
    : new WorkerHeartbeat({ lock: workspaceLock, holder: incarnation, onError: (message) => (o.log ?? console.error)(`[worker] ${message}`) });
  const checkScheduler = new WorkflowCheckScheduler({ reader: store, writer: store, snapshots, environments, redactor, scopes, jobs, recoveryChecks: recoveryCheckPort });
  const schemas = new DefinitionArtifactSchemas(store);
  const schemaValidator = new AjvSchemaValidator();
  const checkArtifactSchemas = async () => {
    for (const type of await store.list<ArtifactType>("ArtifactType")) {
      const schema = await schemas.get(type.metadata.name, type.metadata.namespace!);
      if (schema) schemaValidator.validate(schema.jsonSchema, null);
    }
  };
  await checkArtifactSchemas();
  // AC-8: caches derived from definitions are refreshed after every reload.
  if (secretRefresh) definitions.onReload(() => void secretRefresh.refresh().then(preResolveSecrets).catch((err) => o.log?.("secret refresh after reload failed", err)));
  definitions.onReload(() => {
    preResolveSecrets().catch((err) => o.log?.("secret pre-resolve after reload failed", err));
    checkArtifactSchemas().catch((err) => o.log?.("artifact schema check after reload failed", err));
  });
  const workspaceReaders = new LocalWorkspaceReaders(new RipgrepCodeSearch());
  const draftNotes = new StoreDraftFeedbackBatch({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store });
  const planning = new PlanningService({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, compiler, events, redactor,
    schemas, schemaValidator, readers: workspaceReaders, notes: draftNotes });
  // ADR-0047: verification and unit execution depend on each other's ports; the closure breaks the construction cycle.
  // ADR-0086: flaky decisions become events, and repeatedly flaky tests one proposed issue.
  const flakyTests = new EventFlakyTestReporter({ reader: store, writer: store, events, clock, redactor });
  const verification: VerificationService = new VerificationService({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, compiler,
    snapshots, environments, scheduler: checkScheduler, events, clock, redactor, planning, planReview: planning, recoveryChecks: recoveryCheckPort, logs: transcripts, flaky: flakyTests,
    completeness: { beforeCandidate: (...a) => units.beforeCandidate(...a), assertComplete: (...a) => units.assertComplete(...a) } });
  const recoveryRouter = new ValidatedRecoveryRouter({ reader: store, schemas, validator: schemaValidator, contracts: verification,
    candidates: verification, readers: workspaceReaders });
  recoveryChecks = new DefaultRecoveryCheckAuthorization({ reader: store, compiler, contracts: verification, environments });
  const recoveryAllowances = new RecoveryAllowances({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, compiler, contracts: verification,
    schemas, validator: schemaValidator });
  const recoveryNeeds = new Registry<RecoveryNeedHandler>();
  const runtimeNeed = runtimeRecoveryNeed(environments);
  recoveryNeeds.register(runtimeNeed.type, runtimeNeed);
  const units: UnitExecutionService = new UnitExecutionService({ namespace: DEFAULT_NAMESPACE, reader: store, compiler, contracts: verification, candidates: verification,
    scheduler: checkScheduler, readers: workspaceReaders, events, clock, redactor, flaky: flakyTests });
  // ADR-0055/0057: one check per artifact type, applied when the agent calls `finish` and again after the run.
  const proposedChecks = new Registry<ProposedArtifactCheck>();
  const artifactChecks = new Registry<ArtifactCheck>();
  const candidateDiffs = new GitCandidateDiff();
  // ADR-0095 §7: reviews get a change manifest and read/acknowledge each file; coverage is checked at finish.
  const changeReview = new ChangeReviewService({ diffs: candidateDiffs, candidates: new GitWorkingTreeDiff(), transcripts, readers: workspaceReaders,
    reports: { [PR_REVIEW_REPORT]: prReviewReportReader, [CODE_REVIEW_REPORT]: codeReviewReportReader } });
  const domainChecks = new Map([verification.artifactCheck, planning.artifactCheck, planning.reviewCheck, recoveryRouter.artifactCheck, prReviewArtifactCheck({ reader: store, diffs: candidateDiffs })].map((check) => [check.artifactType, check]));
  const registerArtifactChecks = async () => {
    const artifactTypes = await store.list<ArtifactType>("ArtifactType");
    for (const type of new Set([...artifactTypes.filter((type) => type.spec.schema).map((type) => type.metadata.name), ...domainChecks.keys()])) {
      const check = schemaArtifactCheck(type, schemas, schemaValidator, domainChecks.get(type));
      proposedChecks.register(type, check);
      artifactChecks.register(type, persistedArtifactCheck(check, { reader: store, readers: workspaceReaders }));
    }
  };
  await registerArtifactChecks();
  definitions.onReload(() => void registerArtifactChecks().catch((err) => o.log?.("artifact check refresh after reload failed", err)));
  const contexts = new DefaultContextFactory({
    reader: store,
    providers: [codeSearchProvider(workspaces, new RipgrepCodeSearch()), repositoryDocsProvider(workspaces), knowledgeProvider(knowledge),
      retrospectiveContext(store, redactor), artifactSchemaContext(schemas),
      planningContext({ reader: store, compiler, redactor }),
      verificationContext({ reader: store, logs: transcripts, compiler, redactor }),
      unitContext({ ledger: units, compiler, redactor, attempts: new CompletedUnitAttempts(store) }),
      recoveryContext({ reader: store, redactor }),
      outputFeedbackContext({ reader: store, redactor }), baseConflictProvider(), citedCodeContext(workspaceReaders),
      changeReview],
    models,
    recorders,
    environments,
    compiler,
  });
  const prompts = new DefaultPromptBuilder([changeReview]);
  const recordedTurns = new DefaultRecordedToolTurns();
  const toolProvider = new McpToolProvider({ secrets, redactor, fetch: o.fetch, transportFor: o.mcpTransportFor });
  const outputFinish = new RegistryFinishValidator({ checks: proposedChecks, readers: workspaceReaders });
  const checkFinish = new ActiveCheckFinishValidator(store);
  // ADR-0060: OpenCode is the default agent runtime; the tool loop stays behind it until parity is shown.
  const agentRuntime = env.FACTORY_AGENT_RUNTIME ?? "opencode";
  if (agentRuntime !== "opencode" && agentRuntime !== "tool-loop") throw new Error(`FACTORY_AGENT_RUNTIME must be "opencode" or "tool-loop", got "${agentRuntime}"`);
  const agentRuntimeDir = o.agentRuntimeDir ?? env.FACTORY_AGENT_RUNTIME_DIR ??
    (o.databasePath === ":memory:" ? join(tmpdir(), `factory-opencode-${process.pid}`) : join(dirname(o.databasePath), "opencode"));
  const opencode = agentRuntime === "opencode"
    ? new OpenCodeHost({ dataDir: agentRuntimeDir, fetch: o.fetch, route: o.fetch ? undefined : describeProxy(o.env ?? process.env), log: (msg) => (o.log ?? console.error)(msg) })
    : undefined;
  const finishValidator: FinishValidator = { validate: async (ctx, result) => [...await outputFinish.validate(ctx, result), ...await checkFinish.validate(ctx), ...await changeReview.validate(ctx, result)] };
  // ADR-0080 §2 (S2-a/b): the `AgentRuntime` path. Off unless a backend is selected; when on, the runtime hosts the
  // loop and the workspace (the tool loop first — S4 moves OpenCode in). `bwrap` is a real backend.
  const agentRuntimes = new Registry<AgentRuntime>();
  agentRuntimes.register("bwrap", new BwrapAgentRuntime({
    root: join(agentRuntimeDir, "runtime"),
    // Dev/TS layout (cwd is `web/`); a built runtime image replaces this in S3 (recorded in provenance).
    runnerPath: env.FACTORY_RUNTIME_RUNNER ?? resolve(process.cwd(), "src/agent-runtime/runner.ts"),
    extraRoBinds: env.FACTORY_BWRAP_RO_BINDS?.split(":").filter(Boolean),
    log: (msg) => (o.log ?? console.error)(msg),
  }));
  for (const r of o.agentRuntimes ?? []) agentRuntimes.register(r.backend, r);
  const runtimeBackend = env.FACTORY_AGENT_RUNTIME_BACKEND;
  let runtimeExecutor: AgentRuntimeExecutor | undefined;
  if (runtimeBackend) {
    const { runtime, health } = await new DefaultAgentRuntimeSelector(agentRuntimes, runtimeBackend, agentRuntimes.keys()).select();
    if (!runtime) throw new Error(`FACTORY_AGENT_RUNTIME_BACKEND="${runtimeBackend}" did not resolve to an available AgentRuntime: ${health.message ?? ""}`);
    // Factory-side tool surface (§5): workspace tools are marked local (they run inside the runtime) and refused here.
    const refuse = (): never => { throw new Error("workspace tools run inside the runtime (ADR-0080 §5)"); };
    const runtimeCapabilities = (ctx: ExecutionContext): ToolCapabilities => {
      const reader = workspaceReaders.forWorkspaces(ctx.workspaces);
      return {
        read: reader, search: reader,
        write: { writeFile: async () => refuse() },
        exec: { exec: async () => refuse() },
        artifacts: { diff: async () => refuse() },
        knowledge: scopedSearcher(knowledge, ctx),
        egress: bindEgress(ctx, egress),
        checks: { run: (input) => verification.run(ctx, input) },
        checkLogs: { read: (input) => verification.read(ctx, input) },
        baseline: { run: (input) => verification.runBaseline(ctx, input) },
        changes: changeReview.session(ctx),
      };
    };
    runtimeExecutor = new AgentRuntimeExecutor({
      runtime, reader: store, prompts, tools,
      modelAccess: new DefaultRuntimeModelAccess({ tokens: modelTokens, clock: () => clock.now() }),
      export: new GitBundleIngest(),
      diff: new GitCandidateDiffer(),
      mirrorsDir: join(agentRuntimeDir, "mirrors"),
      capabilities: runtimeCapabilities,
      toolProvider,
      offerings: [verification, changeReview],
      controlServer: createRunControlServerFactory({ proxy: modelProxy }),
      finish: finishValidator,
    });
  }
  const realExecutors = [
    ...(runtimeExecutor ? [runtimeExecutor] : []),
    ...(opencode ? [new OpenCodeExecutor({
      host: opencode,
      reader: store,
      prompts,
      tools,
      environments,
      readers: workspaceReaders,
      scratchDir: join(agentRuntimeDir, "scratch"),
      knowledge,
      toolProvider,
      checks: verification,
      baseline: verification,
      offerings: [verification, changeReview],
      checkLogs: verification,
      changes: changeReview,
      jobs,
      egress,
      finish: finishValidator,
    })] : []),
    new ToolLoopExecutor({
      reader: store,
      prompts,
      tools,
      environments,
      readers: workspaceReaders,
      knowledge,
      toolProvider,
      turns: recordedTurns,
      checks: verification,
      baseline: verification,
      offerings: [verification, changeReview],
      checkLogs: verification,
      changes: changeReview,
      jobs,
      egress,
      finish: finishValidator,
    }),
    new LLMExecutor(prompts, tools),
    new SkillHandlerExecutor(skillHandlers),
  ];
  const executor = new ExecutorChain([...realExecutors, new SimulatedExecutor({ [CODE_REVIEW_REPORT]: simulatedCodeReviewReport })]);
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
  for (const gate of verification.gates) gates.register(gate.type,
    gate.type === "verification-plan-review" ? planningReview(gate, compiler) : gate);
  gates.register(retrospectiveReview.type, retrospectiveReview);
  gates.register(units.gate.type, units.gate);

  // ── sources & outbox (rule 7) ────────────────────────────────────────
  const connectors = new Registry<SourceConnector>();
  connectors.register("manual", manualConnector);
  connectors.register("internal", internalConnector);
  connectors.register("github", new GithubConnector(secrets, o.fetch));
  connectors.register("github-pr", new GithubPullRequestConnector(secrets, o.fetch));
  connectors.register("jira", new JiraConnector(secrets, o.fetch));
  const outbox = new StoreOutbox(store);
  const outboxHandlers = new Registry<OutboxHandler>();
  const comment = commentHandler(connectors);
  outboxHandlers.register(comment.action, comment);
  // ADR-0053: detection follows publication, not the runtime. The git publisher pushes from the workspace checkout,
  // so the git detector works wherever a PR can be opened. A custom publisher must bring its own detector.
  if (o.publisher && !o.baseSync) throw new Error("a custom publisher needs a baseSync (ADR-0053): no pull request is opened without base-conflict detection");
  const baseSync = o.baseSync ?? new GitBaseSync(secrets);
  const conventions = new Registry<CommitMessageConvention>();
  conventions.register(conventionalCommits.type, conventionalCommits);
  const pr = pullRequestHandler({
    reader: store,
    // ADR-0092: the commit is made in the sandbox; the factory only ingests the bundle and pushes.
    publisher: o.publisher ?? new GitBranchPublisher(secrets, new SandboxCandidateCommitter(store, environments)),
    codeHosts: o.codeHosts ?? [new GithubCodeHost(secrets, o.fetch)],
    conflicts: baseSync,
    conventions,
  });
  outboxHandlers.register(pr.action, pr);
  for (const handler of ticketHandlers({ reader: store, connectors, redactor })) outboxHandlers.register(handler.action, handler);
  outboxHandlers.register("create-issue", createIssueHandler({ reader: store, connectors, redactor }));
  outboxHandlers.register("link-issue", createIssueLinkHandler({ reader: store, connectors }));
  outboxHandlers.register(PR_REVIEW_ACTION, prReviewHandler(connectors));
  const sourcePolicies = new Registry<SourceWritePolicy>();
  sourcePolicies.register("comment", { check: (s) => s.spec.sync?.bidirectional ? undefined : "read-only (sync.bidirectional is not true)" });
  sourcePolicies.register("service-desk-reply", { check: (s) => Array.isArray(s.spec.writeBack?.replyVisibilities) && s.spec.writeBack.replyVisibilities.length ? undefined : "reviewed replies are not permitted" });
  sourcePolicies.register("ticket-transition", { check: (s) => s.spec.writeBack?.transitions === true ? undefined : "ticket transitions are not permitted" });
  sourcePolicies.register(CREATE_ISSUE_ACTION, createIssuePolicy);
  sourcePolicies.register(PR_REVIEW_ACTION, prReviewPolicy);
  const publicationGate = ticketPublicationGate({ reader: store, outbox, redactor });
  gates.register(publicationGate.type, publicationGate);

  // ── controllers ──────────────────────────────────────────────────────
  // ADR-0062 §3: the web and worker composition roots are thin selections over this one builder.
  // ADR-0062 §1: in a split deployment the web/worker see each other's writes through the change feed, not an in-process emitter.
  const feedWatcher = role === "all" ? undefined : new FeedWatcher({ feed: changeFeed, reader: store, onError: o.log });
  const watcher: ResourceWatcher = feedWatcher ?? store;
  const reconcileErrors = new EventingReconcileErrorReporter({ reader: store, events, redactor, clock });
  const manager = new ControllerManager(watcher, o.log, reconcileErrors);
  if (role !== "worker") {
    manager.register(createFeedbackCaptureController({ reader: store, writer: store, redactor }));
    manager.register(createRetrospectiveController(store, new DefaultRetrospectiveInvestigator({
      reader: store, writer: store, status: store, aggregation: retrospectiveAggregation, clock,
    }), events, redactor));
  }
  const classifiers = new Registry<CheckResultClassifier>();
  registerCheckResultClassifiers(classifiers);
  const checkpoints = new GitWorkspaceCheckpoint();
  const checkRuns = new CheckActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store,
    transcripts, snapshots, environments, redactor, scopes });
  const checkRunController = createCheckRunController({ reader: store, status: store, logs: transcripts,
    runner: new SandboxCheckRunner(store, environments, Number(env.FACTORY_CHECK_OUTPUT_BYTES ?? DEFAULT_CHECK_OUTPUT_BYTES)), snapshots, checkpoints, checkpointDiff: checkpoints, clock, events, redactor, classifiers, scopes,
    claims: workspaceLock, fenced: new SqliteFencedStatusWriter(store, workspaceLock), holder: incarnation,
    maxPerWorkspace: Number(env.FACTORY_CHECKS_PER_WORKSPACE ?? 1), maxTotal: Number(env.FACTORY_CHECKS_TOTAL ?? 2),
    definitionsLoadedAt,
    changes: new GitCandidateChanges(), contracts: verification, recoveryChecks: recoveryCheckPort, onError: (message) => (o.log ?? console.error)(`[checkrun] ${message}`) });
  // ADR-0062 §3: the CheckRun execution controller runs in the worker (or in "all"); the web root never runs checks.
  if (role !== "web") manager.register(checkRunController);
  // ADR-0084: stage publication blocks beyond the built-in pull request.
  const publishers = new Registry<StagePublisher>();
  publishers.register("issue", storyPublisher({ reader: store, writer: store, redactor, clock, factoryUrl: env.FACTORY_PUBLIC_URL }));
  publishers.register("prReview", prReviewPublisher({ reader: store, outbox, redactor, diffs: candidateDiffs, coverage: changeReview }));
  const agentRunController = createAgentRunController({
    reader: store, writer: store, status: store, events, clock, contexts, executor, recorders, redactor,
    feedback: feedbackCapture,
    gate: executionGate && { policy: executionGate, previews: contexts },
    onError: (message) => (o.log ?? console.error)(`[agentrun] ${message}`),
  });
  const conversationTurns = new Registry<ConversationTurnRunner>();
  const itemRecords = new DefaultWorkItemRecordReader(store);
  const tickets = new TicketActions({ namespace: DEFAULT_NAMESPACE, reader: store, writer: store, connectors, outbox, clock, redactor, compiler, records: itemRecords, events });
  conversationTurns.register("agent-chat", new AgentChatRunner({ reader: store, transcripts, models, tools: toolProvider, turns: recordedTurns, environments, redactor, records: itemRecords }));
  const conversationController = createConversationController({
    reader: store, status: store, recorders, transcripts, turns: conversationTurns, clock, redactor, events,
    onError: (message) => (o.log ?? console.error)(`[conversation] ${message}`),
  });
  if (role !== "worker") {
    manager.register(createWorkItemController({ reader: store, writer: store, status: store, events, clock, compiler, gates, outbox, workspaces: workspaceBackend, publishers,
      stagePolicy: verification, resumptionPolicy: verification, publicationGuard: verification, planReconfirmation: verification, publicationRecovery: verification,
      questionPolicy: planning, intentPolicy: planning, assignments: units, runFailures: units, artifactChecks,
      recovery: recoveryRouter, recoveryNeeds, recoveryAllowances }));
    manager.register(
      createWorkspaceController({ reader: store, status: store, events, preparer: workspaceBackend, cleaner: workspaceBackend, sweeper: workspaceBackend, redactor,
        probe: (workspaceBackend as Partial<WorkspaceProbe>).exists ? (workspaceBackend as unknown as WorkspaceProbe) : undefined,
        integrator: baseSync }),
    );
    manager.register(createOutboxController({ reader: store, status: store, events, clock, handlers: outboxHandlers, redactor, policies: sourcePolicies }));
    manager.register(
      createClarificationSyncController({ reader: store, writer: store, events, connectors, pollMs: o.commentPollMs ?? 60_000 }),
    );
    manager.register(agentRunController);
    manager.register(createClarificationController({ reader: store, status: store, clock }));
    manager.register(createApprovalController({ reader: store, status: store }));
    manager.register(conversationController);
    manager.register(createKnowledgeController({ reader: store, status: store, events, clock }));
    manager.register(createIssueProposalController({ reader: store, status: store, events, clock, outbox, connectors, workItems: store }));
  }

  const syncer = new DefaultSourceSyncer({ reader: store, writer: store, connectors, events, clock, mirrors: mirrorLinkChecker({ reader: store }), origins: followUpOriginResolver({ reader: store, records: itemRecords, redactor, clock }) });

  const responders = new Registry<ConversationResponder>();
  responders.register("explain", new ExplainResponder({ reader: store, transcripts, recorders, models }));
  responders.register("explain-item", new ItemExplainResponder({ records: itemRecords, transcripts, recorders, models, redactor }));
  responders.register("refine-knowledge", new KnowledgeRefineResponder({ reader: store, transcripts, recorders, models, redactor }));

  const capabilities = new Registry<CapabilityDetector>();
  for (const [name, detector] of Object.entries(BUILTIN_CAPABILITY_DETECTORS)) capabilities.register(name, detector);
  const app = new FactoryApp({
    capabilities,
    coverage: changeReview,
    approvalGuards: [retrospectiveReview],
    verificationGuard: verification,
    role,
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
    // ADR-0088: profile-declared tools that are not in the cache yet, per repository (a badge, not a blocked item).
    toolGaps: async () => {
      const gaps: { repository: string; tool: string; type: string }[] = [];
      for (const repository of await store.list<Repository>("Repository")) {
        const profile = repository.spec.sandboxRef
          ? (await resolveRef<SandboxProfile>(store, "SandboxProfile", repository.spec.sandboxRef, nsOf(repository))) ?? undefined
          : undefined;
        for (const outcome of await toolchain.status(profile)) {
          if (outcome.state !== "ready") gaps.push({ repository: repository.metadata.name, tool: outcome.name, type: outcome.type });
        }
      }
      return gaps;
    },
    checkWorkers: async () => {
      // ADR-0062 §3: workers are the live heartbeats; `running` is how many checks they hold right now.
      const workers = await workspaceLock.list(WORKER_LEASE_PREFIX);
      const running = await workspaceLock.list("checkrun/");
      return { workers: new Set(workers.map((l) => l.holder)).size, running: running.length };
    },
    events,
    responders,
    simulation,
    redactor,
    records: itemRecords,
    clock,
    baseConflicts: baseSync,
    notes: draftNotes,
    ticketDrafter: new ProductOwnerTicketDrafter({ reader: store, transcripts, recorders, models, redactor, agent: "product-owner", skill: "ticket-writing" }),
  });

  // ── Browser notifications (ADR-0069): projected from Events by registered rules ──
  const notificationRules = new Registry<NotificationRule>();
  registerNotificationRules(notificationRules);
  const notificationClassifier = new RuleBasedNotificationClassifier({ rules: notificationRules, reader: store, redactor });
  const notifications = new EventNotificationFeed({ reader: store, classifier: notificationClassifier });

  // ── MCP server (ADR-0034): what local agent harnesses may do; gates stay in the UI ──
  const exposedTools = factoryTools({ items: app, answers: app, sources: app, knowledge: app, issues: app, search: knowledge });
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
    planning,
    units,
    recoveryAllowances,
    /** Streamable HTTP MCP endpoint handler (Request → Response). */
    mcp,
    /** ADR-0080 §4: OpenAI-shaped model proxy handler (run-scoped tokens). */
    modelProxy,
    /** Issues/revokes run-scoped model tokens for the proxy. */
    modelTokens,
    /** ADR-0082: factory metrics (tools, tokens, agent/tool time, checks, cost). */
    metrics,
    /** ADR-0082: Prometheus/OpenMetrics export of the metrics, for Grafana scraping. */
    metricsExport,
    /** The exposed tool catalog (also used by tests). */
    exposedTools,
    /** Notification center history (ADR-0069). */
    notifications: notifications as NotificationQueries,
    /** Turns a stored Event into a browser notification (SSE `notification` frames). */
    notificationClassifier: notificationClassifier as NotificationClassifier,
    /** Watch feed for the UI (SSE); the change feed in a split deployment (ADR-0062 §1). */
    watcher: watcher as Pick<typeof store, "watch">,
    /** ADR-0062 §1: the durable change feed (cross-process consumers poll this). */
    changeFeed,
    /** ADR-0062 §1/§2: the fenced, store-backed workspace lock. */
    workspaceLock,
    transcriptTail: transcripts as Pick<typeof transcripts, "tail">,
    manager,
    async start() {
      // ADR-0062 §2: release a previous incarnation's locks, but only after its agent processes are confirmed gone.
      const reaped = await reapStaleIncarnations({ lock: workspaceLock, killer: o.processKiller ?? new NoProcessKiller(), current: incarnation });
      if (reaped.length) (o.log ?? (() => {}))(`released workspace locks held by previous incarnation(s): ${reaped.join(", ")}`);
      await heartbeat?.start();
      await feedWatcher?.start();
      await manager.start();
    },
    async stop() {
      await heartbeat?.stop();
      feedWatcher?.stop();
      secretRefresh?.stop();
      await manager.stop();
      await Promise.all([agentRunController.stop(), conversationController.stop(), checkRunController.stop()]);
      await opencode?.close();
      db.close();
      // Throwaway directories belong to the in-memory store that owned them.
      for (const dir of [ownedWorkspacesDir, ownedToolchainDir, ownedToolchainDir && `${ownedToolchainDir}-homes`]) if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Factory = Awaited<ReturnType<typeof createFactory>>;

/** ADR-0052: an optional, operator-provided price schedule (JSON in `FACTORY_MODEL_PRICES`). Absent/invalid → none. */
function parsePriceSchedule(raw: string | undefined): PriceSchedule | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<PriceSchedule>;
    if (typeof v.version !== "string" || typeof v.source !== "string" || !Array.isArray(v.prices)) return undefined;
    const prices = v.prices.filter((p): p is PriceSchedule["prices"][number] =>
      !!p && typeof p.prefix === "string" && typeof p.prompt === "number" && typeof p.completion === "number");
    return prices.length ? { version: v.version, source: v.source, prices } : undefined;
  } catch {
    return undefined;
  }
}
