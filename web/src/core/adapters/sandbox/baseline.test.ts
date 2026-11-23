import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SandboxSpec } from "../../ports/index.ts";
import { InMemorySandboxEnvironment } from "./basic.ts";
import { HostEnvironment } from "../../testing/host-environment.ts";
import { SandboxCheckRunner } from "./check-runner.ts";
import type { CheckRun, Repository, Workspace } from "../../model/kinds.ts";

test("isolated baseline environments leave the candidate unchanged and clean up", async () => {
  const root = join(process.cwd(), `.baseline-test-${randomUUID()}`);
  const candidate = join(root, "candidate");
  await mkdir(candidate, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: candidate, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Factory Test");
    git("config", "user.email", "factory-test@example.invalid");
    await writeFile(join(candidate, "file.txt"), "baseline\n");
    git("add", "file.txt");
    git("commit", "-qm", "baseline");
    const commit = git("rev-parse", "HEAD");
    await writeFile(join(candidate, "file.txt"), "candidate\n");
    const spec = { profile: { spec: { env: {} } }, repositories: [],
      workspaces: [{ metadata: { name: "ws" }, status: { phase: "Ready", path: candidate, baseCommit: commit } }] } as unknown as SandboxSpec;
    const environment = new HostEnvironment();
    const baseline = await environment.prepareIsolated(spec, { mode: "baseline", commit });
    try {
      assert.equal(await baseline.readFile("file.txt"), "baseline\n");
      await baseline.writeFile("file.txt", "isolated\n");
      assert.equal(await readFile(join(candidate, "file.txt"), "utf8"), "candidate\n");
    } finally { await baseline.dispose(); }
    assert.deepEqual(await readdir(join(root, ".factory-baselines")), []);
    assert.equal(await readFile(join(candidate, "file.txt"), "utf8"), "candidate\n");
    await assert.rejects(environment.prepareIsolated(spec, { mode: "baseline", commit: "a".repeat(40) }), /exact pinned baseline/);

    const fake = new InMemorySandboxEnvironment({ seed: { "file.txt": "baseline" } });
    const isolated = await fake.prepareIsolated(spec, { mode: "baseline", commit });
    await isolated.writeFile("file.txt", "isolated");
    await isolated.dispose();
    assert.equal(await readFile(join(candidate, "file.txt"), "utf8"), "candidate\n");
    assert.equal(fake.sandboxes[0].disposed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostic execution mutates only its isolated candidate snapshot", async () => {
  const environment = new InMemorySandboxEnvironment({ seed: { "candidate.txt": "original" },
    handlers: [(command, files) => { if (!command.includes("diagnose")) return undefined; files.set("candidate.txt", "diagnostic output"); return { exitCode: 0 }; }] });
  const workspace = { metadata: { name: "ws", namespace: "default" }, spec: {}, status: { phase: "Ready", baseCommit: "base" } } as Workspace;
  const repository = { metadata: { name: "repo" }, spec: {} } as Repository;
  const profile = { spec: {} };
  const candidate = await environment.prepare({ profile: profile as never, repositories: [], workspaces: [workspace] });
  const runner = new SandboxCheckRunner({} as never, { select: async () => ({ environment, health: await environment.health(), candidates: [] }), refresh: async () => {} });
  const run = { metadata: { namespace: "default" }, spec: { command: "diagnose", timeoutMs: 1000, snapshot: "candidate",
    environment: { runtime: "in-memory", version: "test", profileVersion: "default" },
    workflow: { purpose: "diagnostic" } } } as CheckRun;
  await runner.execute(run, workspace, repository);
  assert.equal(await candidate.readFile("candidate.txt"), "original");
  assert.equal(environment.sandboxes.at(-1)?.disposed, true);
  await candidate.dispose();
});
