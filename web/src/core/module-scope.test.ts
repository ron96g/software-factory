import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, CheckRun, Repository, WorkItem, Workflow, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { GitModuleScopePlanner } from "./adapters/workspaces/module-scope.ts";
import { GitWorkspaceSnapshotter } from "./adapters/workspaces/snapshot.ts";
import { InMemorySandboxEnvironment, NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { resolveCheckConfig } from "./checks/config.ts";
import { WorkflowCheckScheduler } from "./checks/scheduler.ts";
import { CheckActions } from "./checks/actions.ts";
import { createCheckRunController } from "./checks/controller.ts";
import { checkRunValidator } from "./checks/admission.ts";
import { automatedGate } from "./workflow/checks.ts";
import { Registry } from "./registry/registry.ts";
import { ANONYMOUS, type ExecutionEnvironment, type GateContext } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = async (path: string, value: string) => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, value);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  const graph = {
    shared: { path: "shared", depends_on: [] },
    api: { path: "api", depends_on: ["shared"] },
    client: { path: "client", depends_on: ["api"] },
    unrelated: { path: "unrelated", depends_on: [] },
  };
  await put(".ci/graph.json", JSON.stringify(graph));
  await put("Makefile", "build-all test-all:\n\t@printf '%s\\n' '$(MODULES)'\n");
  await put(".gitignore", "*.ignored\n");
  for (const module of Object.keys(graph)) await put(`${module}/source.go`, "original");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const baseCommit = git("rev-parse", "HEAD");
  const repository: Repository = {
    apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "default", resourceVersion: "1" },
    spec: {
      moduleScope: { graph: ".ci/graph.json", sharedPaths: ["Makefile", ".ci/**", "**/go.mod", "**/go.sum"] },
      checks: {
        build: { command: "make build-all", timeoutMs: 2000, moduleScoped: true },
        test: { command: "make test-all", timeoutMs: 2000, moduleScoped: true },
        full: { command: "make test-all" },
      },
    },
  };
  const item: WorkItem = {
    apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default", uid: "item-uid" },
    spec: { title: "Scoped checks", sourceRef: { name: "manual" } }, status: { phase: "Running", stage: "verify", round: 1 },
  };
  const workspace: Workspace = {
    apiVersion: API_VERSION, kind: "Workspace", metadata: { name: "workspace", namespace: "default", uid: "workspace-uid" },
    spec: { workItemRef: { name: item.metadata.name }, repositoryRef: { name: "repo" }, branch: "factory/item" },
    status: { phase: "Ready", path: root, baseCommit },
  };
  const scopes = new GitModuleScopePlanner();
  const cleanup = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { root, git, put, graph, repository, item, workspace, scopes, cleanup };
}

test("module scope includes committed, staged, dirty, deleted and untracked changes plus transitive dependents", async () => {
  const f = await fixture();
  try {
    await f.put("api/source.go", "committed");
    f.git("add", ".");
    f.git("commit", "-qm", "candidate");
    let scope = await f.scopes.plan(f.workspace, f.repository);
    assert.deepEqual(scope.modules, ["api", "client"]);
    assert.equal(scope.baseCommit, f.workspace.status!.baseCommit);
    assert.equal(scope.mode, "affected");
    await f.put("unrelated/new.go", "staged");
    f.git("add", "unrelated/new.go");
    await rm(join(f.root, "api/source.go"));
    await f.put("shared/new.go", "untracked");
    await f.put("not-a-module.ignored", "ignored");
    scope = await f.scopes.plan(f.workspace, f.repository);
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.modules, ["api", "client", "shared", "unrelated"]);
  } finally { await f.cleanup(); }
});

test("module scope includes both sides of renames, nested owners and dependency cycles", async () => {
  const f = await fixture();
  try {
    await f.put(".ci/graph.json", JSON.stringify({ ...f.graph,
      nested: { path: "api/nested", depends_on: ["client"] },
      client: { path: "client", depends_on: ["api", "nested"] },
    }));
    await f.put("api/nested/file.go", "baseline");
    f.git("add", ".");
    f.git("commit", "-qm", "nested graph");
    f.workspace.status!.baseCommit = f.git("rev-parse", "HEAD");
    await f.put("api/nested/file.go", "changed");
    assert.deepEqual((await f.scopes.plan(f.workspace, f.repository)).modules, ["api/nested", "client"]);
    f.git("mv", "api/source.go", "unrelated/moved.go");
    assert.deepEqual((await f.scopes.plan(f.workspace, f.repository)).modules, ["api", "api/nested", "client", "unrelated"]);
  } finally { await f.cleanup(); }
});

test("shared, unknown, dependency and empty scopes use full Make discovery, never an empty module override", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.scopes.plan(f.workspace, f.repository)).mode, "full");
    for (const path of ["Makefile", ".ci/catalog.yaml", "shared/go.mod", "new-module/file.go", "README.md"]) {
      const original = path === "Makefile" ? await readFile(join(f.root, path), "utf8") : undefined;
      await f.put(path, "changed");
      const config = await resolveCheckConfig(f.repository, "test", f.workspace, f.scopes);
      assert.equal(config.scope?.mode, "full", path);
      assert.equal(config.command, "make test-all");
      if (original !== undefined) await f.put(path, original);
      else await rm(join(f.root, path));
    }
    await f.put("api/file.go", "changed");
    assert.equal((await resolveCheckConfig(f.repository, "full", f.workspace, f.scopes)).scope, undefined);
  } finally { await f.cleanup(); }
});

test("declared non-build paths do not expand code scope or override shared-path protection", async () => {
  const f = await fixture();
  try {
    f.repository.spec.moduleScope!.nonBuildPaths = ["docs/**", "**/*.md", ".ci/**"];
    await f.put("docs/feature.md", "documentation");
    assert.equal((await f.scopes.plan(f.workspace, f.repository)).mode, "full");
    await f.put("api/source.go", "changed");
    assert.deepEqual((await f.scopes.plan(f.workspace, f.repository)).modules, ["api", "client"]);
    await f.put(".ci/shared.md", "shared even though declared non-build");
    assert.equal((await f.scopes.plan(f.workspace, f.repository)).mode, "full");
  } finally { await f.cleanup(); }
});

test("invalid graph, unsafe arguments, escaped graph and missing baseline fail visibly", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "factory-scope-outside-"));
  try {
    await assert.rejects(resolveCheckConfig(f.repository, "test", f.workspace), /planner is unavailable/);
    for (const graph of [{}, { ...f.graph, api: { path: "api;touch pwn", depends_on: [] } },
      { ...f.graph, api: { path: "../outside", depends_on: [] } },
      { ...f.graph, api: { path: "api", depends_on: ["missing"] } },
      { ...f.graph, api: { path: "shared", depends_on: [] } }]) {
      await f.put(".ci/graph.json", JSON.stringify(graph));
      await assert.rejects(f.scopes.plan(f.workspace, f.repository), /graph|module|dependency/);
    }
    await f.put(".ci/graph.json", JSON.stringify(f.graph));
    const copy = structuredClone(f.workspace);
    delete copy.status!.baseCommit;
    await assert.rejects(f.scopes.plan(copy, f.repository), /baseCommit/);
    copy.status!.baseCommit = "f".repeat(40);
    await assert.rejects(f.scopes.plan(copy, f.repository), /git|valid object/i);
    await writeFile(join(outside, "graph.json"), JSON.stringify(f.graph));
    await rm(join(f.root, ".ci/graph.json"));
    await symlink(join(outside, "graph.json"), join(f.root, ".ci/graph.json"));
    await assert.rejects(f.scopes.plan(f.workspace, f.repository), /escapes/);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("legacy gates resolve the same narrow Make commands for build and tests without running unrelated modules", async () => {
  const f = await fixture();
  const db = new DatabaseSync(":memory:");
  try {
    await f.put("api/source.go", "changed");
    const commands: string[] = [];
    const reader = new SqliteStore(db, { now: () => new Date() });
    await reader.create(f.repository);
    await reader.create({ ...f.workspace, metadata: { ...f.workspace.metadata,
      ownerReferences: [{ kind: "WorkItem", name: f.item.metadata.name, uid: f.item.metadata.uid! }] } });
    const gate = automatedGate({
      reader, checks: new Registry(), scopes: f.scopes,
      events: { normal: async () => {}, warning: async () => {} }, redactor: { redact: (value) => value },
      runner: { run: async (_workspace, _repositories, command) => {
        commands.push(command);
        const output = execFileSync("bash", ["-c", command], { cwd: f.root, encoding: "utf8" }).trim();
        assert.equal(output, "api client");
        return { exitCode: 0, output, durationMs: 1 };
      } },
    });

    const ctx: GateContext = { workItem: f.item, stage: { name: "verify", lifecyclePhase: "construction", origin: "workflow", steps: [] },
      gate: { type: "automated", checks: ["build", "test"] } };
    assert.equal((await gate.evaluate(ctx)).action, "wait");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await gate.evaluate(ctx)).action, "advance");
    assert.deepEqual(commands, ["make build-all MODULES='api client'", "make test-all MODULES='api client'"]);
  } finally { db.close(); await f.cleanup(); }
});

test("preparation, gate, agent and standalone jobs pin and revalidate the same scope; forged modules never execute", async () => {
      const f = await fixture();
      const db = new DatabaseSync(":memory:");
      const clock = { now: () => new Date() };
      const store = new SqliteStore(db, clock);
      const logs = new SqliteTranscriptStore(db, clock);
      const redactor = { redact: (text: string) => text };
      const snapshots = new GitWorkspaceSnapshotter();
      const runtimes = new Registry<ExecutionEnvironment>();
      runtimes.register("in-memory", new InMemorySandboxEnvironment());
      runtimes.register("none", new NoSandboxEnvironment());
      const environments = new DefaultEnvironmentSelector(runtimes, "in-memory", []);
      const errors: string[] = [];
      const executed: string[] = [];
      const controller = createCheckRunController({
        reader: store, status: store, logs, scopes: f.scopes, snapshots, clock, redactor,
        events: new StoreEventRecorder(store), onError: (message) => errors.push(message),
        runner: { execute: async (run) => {
          executed.push(run.spec.command);
          return { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 };
        } },
      });
      try {
        await f.put("api/source.go", "changed");
        const repository = await store.create<Repository>({ ...f.repository, spec: {
          ...f.repository.spec, verification: { requiredChecks: ["build", "test"], preflightChecks: [], preparationChecks: ["build"] },
        } });
        const workflow = await store.create<Workflow>({
          apiVersion: API_VERSION, kind: "Workflow", metadata: { name: "workflow", namespace: "default" },
          spec: { phases: [], verification: { planningStage: "plan", reviewStage: "review", preflightStage: "preflight",
            preparationStage: "code-review", verifyStage: "verify", implementationStage: "implement",
            maxCodeAttempts: 2, maxExecutionAttempts: 2, retryDelayMs: 1 } },
        });
        let item = await store.create<WorkItem>({ ...f.item,
          spec: { ...f.item.spec, workflowRef: { name: workflow.metadata.name } } });
        const workspace = await store.create<Workspace>({ ...f.workspace,
          metadata: { ...f.workspace.metadata, ownerReferences: [ownerRef(item)] } });
        const scheduler = new WorkflowCheckScheduler({ reader: store, writer: store, snapshots, environments, redactor, scopes: f.scopes });
        let last: CheckRun | undefined;
        for (const kind of ["preparation", "gate", "agent", "standalone"]) {
          const stage = kind === "preparation" ? "code-review" : "verify";
          item = await store.updateStatus<WorkItem>({ ...item,
            status: { phase: kind === "standalone" ? "Failed" : "Running", stage, round: 1 } });
          let caller: AgentRun | undefined;
          if (kind === "agent") caller = await store.create<AgentRun>({
            apiVersion: API_VERSION, kind: "AgentRun", metadata: { name: "item-verify-0-r1", namespace: "default",
              ownerReferences: [ownerRef(item)], labels: { "factory.ai-dlc.io/stage": stage, "factory.ai-dlc.io/workitem": item.metadata.name } },
            spec: { workItemRef: { name: item.metadata.name }, stage, step: "verify", agentRef: { name: "verifier" },
              skillRefs: [], inputs: [], outputs: [] }, status: { phase: "Running" },
          });
          const check = kind === "preparation" ? "build" : "test";
          const run = kind === "standalone"
            ? await new CheckActions({ namespace: "default", reader: store, writer: store, transcripts: logs,
              snapshots, environments, redactor, scopes: f.scopes }).submit(ANONYMOUS, item.metadata.name,
                { workspace: workspace.metadata.name, check, requestId: kind })
            : await scheduler.submit({ workItem: item, workspace, repository, check, requestId: kind, requestedBy: kind,
              workflow: { purpose: kind === "preparation" ? "preparation" : "verification", stage, round: 1, attempt: 1,
                planFingerprint: "approved-plan", ...(caller ? { agentRunRef: { name: caller.metadata.name }, agentRunUid: caller.metadata.uid } : {}) } });
          assert.equal(run.spec.command, `make ${check === "build" ? "build" : "test"}-all MODULES='api client'`, kind);
          assert.deepEqual(run.spec.scope?.modules, ["api", "client"], kind);
          const validator = checkRunValidator(f.scopes);
          assert.deepEqual(await validator.validate(run, { operation: "CREATE", reader: store }), []);
          assert.ok((await validator.validate({ ...run, spec: { ...run.spec, scope: { ...run.spec.scope!, modules: ["unrelated"] } } },
            { operation: "CREATE", reader: store })).some((error) => error.includes("scope")));
          await controller.reconcile(keyOf(run));
          await controller.stop();
          const completed = await store.get<CheckRun>("CheckRun", "default", run.metadata.name);
          assert.equal(completed?.status?.outcome, "Passed", `${kind}: ${completed?.status?.message}`);
          if (caller) await store.updateStatus<AgentRun>({ ...caller, status: { phase: "Succeeded" } });
          last = run;
        }
        const forged = await store.create<CheckRun>({ ...last!, metadata: { name: "forged-scope", namespace: "default",
          ownerReferences: [ownerRef(item)] }, spec: { ...last!.spec, scope: { ...last!.spec.scope!, modules: ["unrelated"] } } });
        await controller.reconcile(keyOf(forged));
        await controller.stop();
        assert.equal((await store.get<CheckRun>("CheckRun", "default", forged.metadata.name))?.status?.outcome, "NotVerified");
        assert.equal(executed.length, 4);
        assert.deepEqual(errors, []);
      } finally { await controller.stop(); db.close(); await f.cleanup(); }
});
