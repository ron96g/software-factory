import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { InMemorySandboxEnvironment, NoSandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { DefaultEnvironmentSelector } from "./agents/environment-selector.ts";
import { Registry } from "./registry/registry.ts";
import { createFactory } from "./factory.ts";
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

test("S2: without a runtime, construction agents are simulated with a visible reason; health is reported", async () => {
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: ":memory:", env: {}, log: () => {} });
  await f.start();
  try {
    const h = await f.app.systemHealth(ANONYMOUS);
    assert.equal(h.sandbox.runtime, "none");
    assert.equal(h.sandbox.available, false);
    assert.equal(h.llm.available, false);

    const wi = await f.app.createWorkItem(ANONYMOUS, { title: "Sandbox reason", description: "A long enough description so triage accepts it right away." });
    for (let i = 0; i < 400; i++) {
      const d = await f.app.getWorkItem(ANONYMOUS, wi.metadata.name);
      if (d?.workItem.status?.stage === "spec-review") {
        await f.app.decideApproval(ANONYMOUS, d.approvals.at(-1)!.metadata.name, "approve");
      }
      const dev = d?.runs.find((r) => r.spec.step === "write-code" && r.status?.phase === "Succeeded");
      if (dev) {
        assert.equal(dev.status?.provenance?.executionEnvironment, "none");
        const t = await f.app.runTranscript(ANONYMOUS, dev.metadata.name);
        assert.ok(t.some((m) => /needs a sandbox, but no sandbox runtime available/.test(m.content)), "reason recorded");
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("developer run never finished");
  } finally {
    await f.stop();
  }
});

test("ADR-0020/0021: git worktree workspace + host sandbox; changes persist per item; checkout untouched; env scrubbed", async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HostEnvironment } = await import("./adapters/sandbox/host.ts");
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
  assert.equal((await env.health()).waivesIsolation, true);
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
  assert.match(execFileSync("git", ["branch", "--list", "factory/item-1"], { cwd: repoDir }).toString(), /factory\/item-1/, "branch kept");
});
