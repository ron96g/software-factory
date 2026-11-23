import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { InMemorySandboxEnvironment, NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { Registry } from "./registry/registry.ts";
import { createFactory } from "./factory.ts";
import { testDefinitions } from "./testing/definitions.ts";
import { ANONYMOUS, SandboxUnavailableError, type ExecutionEnvironment, type SandboxSpec } from "./ports/index.ts";

const spec = { run: { metadata: { name: "r1" } }, profile: {}, repositories: [] } as unknown as SandboxSpec;

/** Contract every ExecutionEnvironment adapter must satisfy (run against real adapters too, once they exist). */
async function sandboxContract(env: ExecutionEnvironment) {
  const h = await env.health();
  assert.equal(h.runtime, env.runtime);
  if (!h.available) {
    await assert.rejects(env.prepare(spec), SandboxUnavailableError);
    return;
  }
  const sb = await env.prepare(spec);
  await sb.writeFile("src/a.txt", "hello");
  assert.equal(await sb.readFile("src/a.txt"), "hello");
  assert.ok((await sb.listFiles("src/*")).includes("src/a.txt"));
  await assert.rejects(sb.writeFile("../escape", "x"), /escapes/);
  // SEC-1/P0-1: the file tools reject `..`, absolute paths and `.git` on both reads and writes.
  await assert.rejects(sb.writeFile(".git/config", "x"), /escapes/);
  await assert.rejects(sb.readFile("../escape"), /escapes/);
  await assert.rejects(sb.readFile(".git/config"), /escapes/);
  await assert.rejects(sb.readFile("/etc/hostname"), /escapes/);
  const r = await sb.exec("definitely-not-a-command");
  assert.notEqual(r.exitCode, 0);
  assert.match(await sb.diff(), /\+hello/);
  await sb.dispose();
  await sb.dispose(); // idempotent
}

test("contract: in-memory sandbox", () => sandboxContract(new InMemorySandboxEnvironment()));
test("contract: none sandbox", () => sandboxContract(new NoSandboxEnvironment()));

test("selector: auto picks the first available runtime; explicit unavailable falls back to none with reason", async () => {
  const envs = new Registry<ExecutionEnvironment>();
  envs.register("none", new NoSandboxEnvironment());
  envs.register("in-memory", new InMemorySandboxEnvironment());
  const auto = await new DefaultEnvironmentSelector(envs, "auto", ["podman", "in-memory"]).select();
  assert.equal(auto.environment.runtime, "in-memory");
  assert.equal(auto.candidates[0].message, "adapter not installed");

  const explicit = await new DefaultEnvironmentSelector(envs, "podman", []).select();
  assert.equal(explicit.environment.runtime, "none");
  assert.match(explicit.health.message!, /configured runtime "podman" is unavailable/);
});

test("ADR-0080 §10: FACTORY_SANDBOX_RUNTIME=host fails loudly (no execution without a primitive)", async () => {
  await assert.rejects(
    createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), definitionLoader: testDefinitions(), databasePath: ":memory:", env: { FACTORY_SANDBOX_RUNTIME: "host" }, log: () => {} }),
    /no longer supported[\s\S]*bwrap/,
  );
});

test("S2: without a runtime, construction agents are simulated with a visible reason; health is reported", async () => {
  // Pin the runtime: `auto` would otherwise select bwrap on a host that has it, and this test is about the no-runtime path.
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), definitionLoader: testDefinitions(), databasePath: ":memory:", env: { FACTORY_SANDBOX_RUNTIME: "none" }, log: () => {} });
  await f.start();
  try {
    const h = await f.app.systemHealth(ANONYMOUS);
    assert.equal(h.sandbox.runtime, "none");
    assert.equal(h.sandbox.available, false);
    assert.equal(h.llm.available, false);

    const wi = await f.app.createWorkItem(ANONYMOUS, { title: "Sandbox reason", description: "A long enough description so triage accepts it right away.", workflowRef: "test-loop" });
    for (let i = 0; i < 400; i++) {
      const d = await f.app.getWorkItem(ANONYMOUS, wi.metadata.name);
      if (d?.workItem.status?.stage === "spec-review" && d.workItem.status.phase === "AwaitingApproval") {
        const approval = d.approvals.find((a) => !a.spec.decision);
        if (approval) await f.app.decideApproval(ANONYMOUS, approval.metadata.name, "approve");
      }
      const dev = d?.runs.find((r) => r.spec.step === "write-code" && r.status?.phase === "Succeeded");
      if (dev) {
        assert.equal(dev.status?.provenance?.executionEnvironment, "none");
        const t = await f.app.runTranscript(ANONYMOUS, dev.metadata.name);
        assert.ok(t.some((m) => /needs a sandbox, but/.test(m.content)), "reason recorded");
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("developer run never finished");
  } finally {
    await f.stop();
  }
});

test("ADR-0021: git worktree workspace + unsandboxed test helper; changes persist per item; checkout untouched; env scrubbed", async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HostEnvironment } = await import("./testing/host-environment.ts");
  const { GitWorktreeWorkspaces } = await import("./adapters/workspaces/git-worktree.ts");
  const repoDir = mkdtempSync(join(tmpdir(), "sf-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repoDir });
  g("init", "-q");
  writeFileSync(join(repoDir, "a.txt"), "one\n");
  g("add", ".");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

  const backend = new GitWorktreeWorkspaces({ definitionsRoot: repoDir, workspacesDir: `${repoDir}-ws` });
  const repo = { metadata: { name: "repo" }, spec: { local: { path: repoDir } } } as never;
  assert.equal(backend.supports(repo), true);
  const ws = {
    metadata: { name: "item-1-repo" },
    spec: { workItemRef: { name: "item-1" }, repositoryRef: { name: "repo" }, branch: "factory/item-1", setup: ["echo setup-ran > .setup-marker"] },
  } as never as import("./model/kinds.ts").Workspace;
  const prepared = await backend.prepare(ws, repo);
  assert.ok(existsSync(join(prepared.path, ".setup-marker")), "setup ran");
  const ready = { ...ws, status: { phase: "Ready" as const, ...prepared } };

  const env = new HostEnvironment();
  assert.equal((await env.health()).isolation, "none");
  const spec = { run: { metadata: { name: "r1" } }, profile: {}, repositories: [repo], workspaces: [ready] } as unknown as SandboxSpec;
  const sb = await env.prepare(spec);
  await sb.writeFile("src/new.txt", "hello");
  await assert.rejects(sb.writeFile("../escape", "x"), /escapes/);
  await assert.rejects(sb.writeFile(".git/config", "x"), /escapes/);
  process.env.SF_TEST_SECRET = "sk-should-not-leak";
  const r = await sb.exec('echo "key=[$SF_TEST_SECRET]" && cat a.txt');
  assert.match(r.stdout, /key=\[\]/, "factory env is scrubbed");
  assert.match(await sb.diff(), /\+hello/);
  assert.notEqual((await sb.exec("sleep 5", { timeoutMs: 200 })).exitCode, 0, "timeout kills");
  await sb.dispose();

  // re-prepare is idempotent and keeps the pinned base; next run sees earlier changes
  const again = await backend.prepare({ ...ready } as never, repo);
  assert.equal(again.baseCommit, prepared.baseCommit);
  assert.equal(await (await env.prepare(spec)).readFile("src/new.txt"), "hello");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString().trim(), "", "checkout untouched");

  await backend.remove(ready, repo);
  assert.equal(existsSync(prepared.path), false, "cleaned up");

  // level-triggered sweep: an orphaned worktree (resource gone, e.g. after a crash) is removed; live ones stay
  const orphan = await backend.prepare({ ...ws, metadata: { name: "item-2-repo" }, spec: { ...ws.spec, workItemRef: { name: "item-2" }, branch: "factory/item-2", setup: [] } } as never, repo);
  const live = await backend.prepare({ ...ws, metadata: { name: "item-3-repo" }, spec: { ...ws.spec, workItemRef: { name: "item-3" }, branch: "factory/item-3", setup: [] } } as never, repo);
  const swept = await backend.sweep([{ workItem: "item-3", repository: "repo" }]);
  assert.deepEqual(swept, [orphan.path]);
  assert.equal(existsSync(live.path), true);
  await assert.rejects(backend.remove({ ...ready, status: { ...ready.status, path: "/etc" } } as never, repo), /outside the workspaces dir/);
  assert.match(execFileSync("git", ["branch", "--list", "factory/item-1"], { cwd: repoDir }).toString(), /factory\/item-1/, "branch kept");
});

test("P0-1/SEC-1: host and bwrap file tools refuse symlink escapes outside the workspace", async (t) => {
  const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HostEnvironment } = await import("./testing/host-environment.ts");
  const { BwrapEnvironment } = await import("./adapters/sandbox/bwrap.ts");

  const dir = mkdtempSync(join(tmpdir(), "sf-escape-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.txt"), "one\n");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    g("init", "-q");
    g("add", ".");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    // A directory and a file outside the workspace, reachable through committed symlinks.
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(repo, "evil-dir"));
    symlinkSync(join(outside, "secret.txt"), join(repo, "evil-file"));

    const repository = { metadata: { name: "repo" }, spec: { local: { path: repo } } } as never;
    const workspace = { metadata: { name: "item-repo" }, spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" }, status: { phase: "Ready", path: repo, baseCommit } } as never;

    for (const env of [new HostEnvironment(), new BwrapEnvironment()]) {
      const health = await env.health();
      if (!health.available) {
        t.diagnostic(`skipping ${env.runtime}: ${health.message}`);
        continue;
      }
      const spec = { run: { metadata: { name: "r1" } }, profile: {}, repositories: [repository], workspaces: [workspace] } as unknown as SandboxSpec;
      const sb = await env.prepare(spec);
      try {
        await assert.rejects(sb.readFile("evil-dir/secret.txt"), /escapes/);
        await assert.rejects(sb.readFile("evil-file"), /escapes/);
        await assert.rejects(sb.writeFile("evil-dir/planted.txt", "x"), /escapes/);
        await assert.rejects(sb.readFile(".git/config"), /escapes/);
        await assert.rejects(sb.readFile("/etc/hostname"), /escapes/);
        // A normal in-workspace write still works.
        await sb.writeFile("src/new.txt", "hello");
        assert.equal(await sb.readFile("src/new.txt"), "hello");
      } finally {
        await sb.dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
