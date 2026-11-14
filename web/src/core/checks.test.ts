import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { CheckRun, Repository, WorkItem, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { keyOf, ownerRef } from "./model/meta.ts";
import { ANONYMOUS, type CheckExecutionRunner, type ExecResult, type ExecutionEnvironment } from "./ports/index.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { SqliteTranscriptStore } from "./transcripts/sqlite-transcripts.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { SecretRedactor } from "./transcripts/recorder.ts";
import { InMemorySandboxEnvironment, NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { Registry } from "./registry/registry.ts";
import { CheckActions } from "./checks/actions.ts";
import { createCheckRunController } from "./checks/controller.ts";
import { checkRunValidator } from "./checks/admission.ts";
import { GitWorkspaceSnapshotter } from "./adapters/workspaces/snapshot.ts";
import { HostEnvironment } from "./adapters/sandbox/host.ts";
import { SandboxCheckRunner } from "./adapters/sandbox/check-runner.ts";
import { createFactory } from "./factory.ts";

async function fixture(database = ":memory:") {
  const db = new DatabaseSync(database);
  const clock = { now: () => new Date() };
  const store = new SqliteStore(db, clock);
  const logs = new SqliteTranscriptStore(db, clock);
  const redactor = new SecretRedactor();
  redactor.add("SECRET_VALUE");
  const environments = new Registry<ExecutionEnvironment>();
  environments.register("in-memory", new InMemorySandboxEnvironment());
  environments.register("none", new NoSandboxEnvironment());
  const selector = new DefaultEnvironmentSelector(environments, "in-memory", []);
  const repository = await store.create<Repository>({
    apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
    spec: { checks: { test: { command: "trusted-test-command", timeoutMs: 42 }, build: "trusted-build-command" } },
  });
  const item = await store.create<WorkItem>({
    apiVersion: API_VERSION, kind: "WorkItem", metadata: { name: "item", namespace: "default" },
    spec: { title: "Check fixture", sourceRef: { name: "manual" } }, status: { phase: "Failed" },
  });
  const workspace = await store.create<Workspace>({
    apiVersion: API_VERSION, kind: "Workspace",
    metadata: { name: "workspace", namespace: "default", ownerReferences: [ownerRef(item)] },
    spec: { repositoryRef: { name: "repo" }, workItemRef: { name: "item" }, branch: "factory/item" },
    status: { phase: "Ready", path: "/fake-workspace" },
  });
  let fingerprint = "tree-a";
  const snapshots = { fingerprint: async () => fingerprint };
  const actions = new CheckActions({ namespace: "default", reader: store, writer: store, transcripts: logs,
    snapshots, environments: selector, redactor });
  let calls = 0;
  let result: ExecResult = { exitCode: 0, stdout: "SECRET_VALUE", stderr: "", truncated: false, durationMs: 5, termination: { kind: "exit" } };
  const runner: CheckExecutionRunner = { execute: async () => { calls++; return result; } };
  const errors: string[] = [];
  const controller = (execution = runner) => createCheckRunController({ reader: store, status: store, logs, runner: execution,
    snapshots, clock, events: new StoreEventRecorder(store), redactor, onError: (message) => errors.push(message) });
  const submit = (requestId = "request") => actions.submit(ANONYMOUS, "item", { workspace: "workspace", check: "test", requestId });
  return { db, store, logs, actions, controller, submit, item, workspace, repository, errors,
    calls: () => calls, snapshot: (value: string) => { fingerprint = value; }, result: (value: ExecResult) => { result = value; } };
}

test("standalone checks: idempotent named submission, immutable evidence, redacted logs and no workflow progress", async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(await f.store.get("WorkItem", "default", "item"));
    const run = await f.submit();
    assert.equal(run.spec.timeoutMs, 42);
    assert.equal((await f.submit()).metadata.uid, run.metadata.uid);
    await assert.rejects(f.actions.submit(ANONYMOUS, "item", { workspace: "workspace", check: "build", requestId: "request" }), /different input/);
    await assert.rejects(f.submit("different"), /pending or running/);
    const c = f.controller();
    await c.reconcile(keyOf(run));
    await c.stop();
    await c.reconcile(keyOf(run));
    assert.equal(f.calls(), 1);
    const done = (await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name))!;
    assert.equal(done.status?.outcome, "Passed");
    const logs = await f.actions.logs(ANONYMOUS, run.metadata.name);
    assert.match(logs[0].content, /redacted/i);
    assert.ok(!JSON.stringify(logs).includes("SECRET_VALUE"));
    assert.equal(JSON.stringify(await f.store.get("WorkItem", "default", "item")), original);
    assert.equal((await f.actions.inspect(ANONYMOUS, "item")).options.length, 2);
    assert.equal((await f.actions.logs(ANONYMOUS, run.metadata.name, logs.at(-1)!.seq)).length, 0);
    for (let i = 0; i < 51; i++) await f.logs.append(done.status!.logRef!, {
      role: "note", author: { type: "system", id: "test" }, content: `entry ${i}`,
    });
    const first = await f.actions.logs(ANONYMOUS, run.metadata.name);
    const second = await f.actions.logs(ANONYMOUS, run.metadata.name, first.at(-1)!.seq);
    assert.equal(first.length, 50);
    assert.equal(second.length, 2);
    assert.ok(second[0].seq > first.at(-1)!.seq);
    const validator = checkRunValidator();
    assert.deepEqual(await validator.validate(run, { operation: "UPDATE", oldObject: run, reader: f.store }), []);
    assert.ok((await validator.validate({ ...run, spec: { ...run.spec, command: "forged" } }, { operation: "UPDATE", oldObject: run, reader: f.store })).length);
    assert.deepEqual(f.errors, []);
  } finally { f.db.close(); }
});

test("structured outcomes distinguish timeout, signal, nonzero exit, incomplete logs and candidate mutation", async () => {
  const f = await fixture();
  try {
    const scenarios: { result: ExecResult; outcome: string; mutate?: boolean }[] = [
      { result: { exitCode: 137, stdout: "", stderr: "timeout", truncated: false, durationMs: 42, termination: { kind: "timeout", signal: "SIGKILL" } }, outcome: "TimedOut" },
      { result: { exitCode: 137, stdout: "", stderr: "", truncated: false, durationMs: 5, termination: { kind: "signal", signal: "SIGTERM" } }, outcome: "Cancelled" },
      { result: { exitCode: 137, stdout: "", stderr: "", truncated: false, durationMs: 5, termination: { kind: "exit" } }, outcome: "UnknownFailure" },
      { result: { exitCode: 127, stdout: "", stderr: "spawn failed", truncated: false, durationMs: 5, termination: { kind: "spawn-error" } }, outcome: "Unavailable" },
      { result: { exitCode: 0, stdout: "truncated", stderr: "", truncated: true, durationMs: 5 }, outcome: "Passed" },
      { result: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 5 }, outcome: "NotVerified", mutate: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      f.snapshot("tree-a");
      f.result(scenario.result);
      const run = await f.submit(`outcome-${index}`);
      const c = f.controller(scenario.mutate ? { execute: async () => { f.snapshot("tree-b"); return scenario.result; } } : undefined);
      await c.reconcile(keyOf(run));
      await c.stop();
      const done = await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name);
      assert.equal(done?.status?.outcome, scenario.outcome);
      assert.equal(done?.status?.logsIncomplete, scenario.result.truncated ||
        scenario.result.termination?.kind === "timeout" || scenario.result.termination?.kind === "signal" ||
        scenario.result.termination?.kind === "spawn-error");
      assert.equal((await f.store.get<WorkItem>("WorkItem", "default", "item"))?.status?.phase, "Failed");
    }
  } finally { f.db.close(); }
});

test("stale, foreign and forged checks cannot execute; interrupted checks never blindly repeat", async () => {
  const f = await fixture();
  try {
    const run = await f.submit();
    f.snapshot("changed-before-start");
    const c = f.controller();
    await c.reconcile(keyOf(run));
    await c.stop();
    assert.equal(f.calls(), 0);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", run.metadata.name))?.status?.outcome, "NotVerified");
    await assert.rejects(f.actions.submit(ANONYMOUS, "item", { workspace: "workspace", check: "invented", requestId: "bad" }), /not configured/);
    await assert.rejects(f.actions.logs(ANONYMOUS, run.metadata.name, -1), /non-negative/);
    await f.store.create<WorkItem>({ ...f.item, metadata: { name: "other", namespace: "default" } });
    await assert.rejects(f.actions.submit(ANONYMOUS, "other", { workspace: "workspace", check: "test", requestId: "foreign" }), /owned by/);
    const second = await f.submit("interrupted");
    const ref = await f.logs.open("default", { kind: "CheckRun", name: second.metadata.name });
    await f.store.updateStatus<CheckRun>({ ...second, status: { phase: "Running", logRef: ref } });
    const freshController = f.controller();
    await freshController.reconcile(keyOf(second));
    assert.equal(f.calls(), 0);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "default", second.metadata.name))?.status?.phase, "Interrupted");
    const foreign = await f.store.create<CheckRun>({ ...second, metadata: { name: "foreign", namespace: "other" },
      spec: { ...second.spec, workItemRef: { name: "item", namespace: "default" } } });
    await freshController.reconcile(keyOf(foreign));
    await freshController.stop();
    assert.equal(f.calls(), 0);
    assert.equal((await f.store.get<CheckRun>("CheckRun", "other", "foreign"))?.status?.outcome, "NotVerified");
  } finally { f.db.close(); }
});

test("check completion and logs survive database reopen; shutdown drains execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sf-check-db-"));
  const f = await fixture(join(directory, "checks.sqlite"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const c = f.controller({ execute: async () => { await blocked; return { exitCode: 0, stdout: "persisted", stderr: "", truncated: false, durationMs: 5 }; } });
  try {
    const run = await f.submit();
    await c.reconcile(keyOf(run));
    let drained = false;
    const stopping = c.stop().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(drained, false);
    release();
    await stopping;
    f.db.close();
    const db = new DatabaseSync(join(directory, "checks.sqlite"));
    try {
      const clock = { now: () => new Date() };
      const store = new SqliteStore(db, clock);
      const done = (await store.get<CheckRun>("CheckRun", "default", run.metadata.name))!;
      assert.equal(done.status?.outcome, "Passed");
      const entries = await new SqliteTranscriptStore(db, clock).read(done.status!.logRef!);
      assert.match(entries[0].content, /persisted/);
    } finally { db.close(); }
  } finally { release(); await c.stop(); if (f.db.isOpen) f.db.close(); await rm(directory, { recursive: true }); }
});

test("pending standalone checks block human restarts; unhandled restarts block new check requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sf-check-guard-"));
  const path = join(directory, "checks.sqlite");
  const f = await fixture(path);
  const factory = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: path, env: {}, log: () => {} });
  try {
    const run = await f.submit();
    await assert.rejects(factory.app.restartWorkItem(ANONYMOUS, "item"), /standalone check/);
    assert.equal((await f.store.get<WorkItem>("WorkItem", "default", "item"))?.spec.restart, undefined);
    const c = f.controller();
    await c.reconcile(keyOf(run));
    await c.stop();
    const item = (await f.store.get<WorkItem>("WorkItem", "default", "item"))!;
    await f.store.update({ ...item, spec: { ...item.spec, restart: { id: "restart", requestedBy: "human" } } });
    await assert.rejects(f.submit("after-restart"), /stopped/);
    assert.equal((await f.actions.inspect(ANONYMOUS, "item")).options.length, 0);
  } finally { await factory.stop(); f.db.close(); await rm(directory, { recursive: true }); }
});

test("real sandbox preserves failed pipelines and timeout metadata; snapshot includes untracked files without following symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sf-check-host-"));
  const f = await fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "tracked"), "original");
    execFileSync("git", ["add", "tracked"], { cwd: directory });
    const ws: Workspace = { ...f.workspace, status: { phase: "Ready", path: directory, baseCommit: "base" } };
    const snapshots = new GitWorkspaceSnapshotter();
    const before = await snapshots.fingerprint(ws);
    await writeFile(join(directory, "new"), "new content");
    assert.notEqual(await snapshots.fingerprint(ws), before);
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, "sub", "entry"), "tracked child");
    execFileSync("git", ["add", "sub/entry"], { cwd: directory });
    await rm(join(directory, "sub"), { recursive: true });
    await symlink(tmpdir(), join(directory, "sub"));
    await assert.rejects(snapshots.fingerprint(ws), /escapes/);
    await rm(join(directory, "sub"));
    const env = new HostEnvironment();
    const health = await env.health();
    const runner = new SandboxCheckRunner(f.store, { select: async () => ({ environment: env, health, candidates: [health] }), refresh: async () => {} });
    const submitted = await f.submit();
    const run: CheckRun = { ...submitted, spec: { ...submitted.spec,
      command: "false | tail -1; printf 'incorrect success'", timeoutMs: 2000,
      environment: { runtime: health.runtime, version: health.version, profileVersion: "default" } } };
    const failed = await runner.execute(run, ws, f.repository);
    assert.notEqual(failed.exitCode, 0);
    assert.ok(!failed.stdout.includes("incorrect success"));
    const timeout = await runner.execute({ ...run, spec: { ...run.spec, command: "sleep 3", timeoutMs: 25 } }, ws, f.repository);
    assert.equal(timeout.termination?.kind, "timeout");
    const explicit137 = await runner.execute({ ...run, spec: { ...run.spec, command: "exit 137" } }, ws, f.repository);
    assert.equal(explicit137.termination?.kind, "exit");
    const oversized = await runner.execute({ ...run, spec: { ...run.spec,
      command: "printf '%100s' a; printf '%100s' a >&2; sleep 0.05; printf '%65437s' b; printf '%65437s' b >&2",
    } }, ws, f.repository);
    assert.equal(oversized.truncated, true);
    assert.equal(Buffer.byteLength(oversized.stdout), 65536);
    assert.equal(Buffer.byteLength(oversized.stderr), 65536);
  } finally { f.db.close(); await rm(directory, { recursive: true }); }
});
