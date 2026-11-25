import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceController } from "./runtime/controllers/workspace.ts";
import { GitWorktreeWorkspaces } from "./adapters/workspaces/git-worktree.ts";
import type { Repository, Workspace } from "./model/kinds.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ADR-0021: a `Ready` workspace whose files vanished is re-prepared, not looped on `ENOENT` forever. */
test("workspace controller: a Ready workspace whose files are gone is re-prepared (setup re-runs)", async () => {
  const repo: Repository = { apiVersion: "v", kind: "Repository", metadata: { name: "software-factory", namespace: "factory-system" }, spec: { local: { path: "." } } } as unknown as Repository;
  const ws: Workspace = {
    apiVersion: "v", kind: "Workspace",
    metadata: { name: "item-software-factory", namespace: "default" },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "software-factory" }, branch: "factory/item", setup: ["cd web && npm ci"] },
    status: { phase: "Ready", path: "/gone/ws", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), preparedBy: "host-git-worktree", setupCompleted: true },
  } as unknown as Workspace;

  const store = new Map<string, unknown>([[`Workspace/${ws.metadata.name}`, ws], ["Repository/software-factory", repo]]);
  const events: { reason: string }[] = [];
  let filesPresent = false; // the workspace files are gone
  let prepared = 0;
  let prepareInput: Workspace | undefined;

  const controller = createWorkspaceController({
    reader: { get: async (kind: string, _ns: string, name: string) => (store.get(`${kind}/${name}`) as never) ?? null, list: async (kind: string) => [...store.values()].filter((r) => (r as { kind?: string }).kind === kind) } as never,
    status: { updateStatus: async (r: { kind: string; metadata: { name: string } }) => { store.set(`${r.kind}/${r.metadata.name}`, r); return r; } } as never,
    events: { normal: async () => {}, warning: async (_r: unknown, reason: string) => { events.push({ reason }); } } as never,
    preparer: { prepare: async (w: Workspace) => { prepared++; prepareInput = w; filesPresent = true; return { path: "/gone/ws", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), preparedBy: "host-git-worktree", setupCompleted: true }; } } as never,
    probe: { exists: () => filesPresent } as never,
    cleaner: { remove: async () => {} } as never,
    sweeper: { sweep: async () => [] } as never,
    integrator: { integrate: async () => ({ baseCommit: "a", headCommit: "b", conflicts: [] }) } as never,
    redactor: { redact: (s: string) => s } as never,
  });

  // The resync/startup path must include a Ready-but-missing workspace.
  assert.ok((await controller.initialKeys()).includes("default/item-software-factory"));

  await controller.reconcile("default/item-software-factory");
  for (let i = 0; i < 100 && prepared === 0; i++) await sleep(5);

  assert.equal(prepared, 1, "the controller re-prepared the workspace");
  assert.equal(prepareInput?.status?.phase, "Preparing", "re-prepare starts from Preparing");
  assert.equal(prepareInput?.status?.setupCompleted, false, "setup is forced to re-run");
  assert.ok(events.some((e) => e.reason === "WorkspaceLost"), "a visible warning is recorded");
  const after = store.get("Workspace/item-software-factory") as Workspace;
  assert.equal(after.status?.phase, "Ready");
  assert.equal(after.status?.setupCompleted, true);
});

/** ADR-0021: the real worktree backend reports a vanished worktree, and `prepare` re-attaches it. */
test("GitWorktreeWorkspaces.exists detects a removed worktree and prepare re-attaches it", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "sf-ws-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repoDir });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repoDir, "a.txt"), "one\n");
  g("add", ".");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoDir });

  const backend = new GitWorktreeWorkspaces({ definitionsRoot: repoDir, workspacesDir: mkdtempSync(join(tmpdir(), "sf-ws-")), secrets: { resolve: () => undefined } });
  const repo = { metadata: { name: "repo", namespace: "default" }, spec: { local: { path: repoDir } } } as unknown as Repository;
  const ws = { apiVersion: "v", kind: "Workspace", metadata: { name: "item-repo", namespace: "default" }, spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" } } as unknown as Workspace;

  const p = await backend.prepare(ws, repo);
  const ready = { ...ws, status: { phase: "Ready", path: p.path, baseCommit: p.baseCommit, setupCompleted: true } } as unknown as Workspace;
  assert.equal(backend.exists(ready), true);

  rmSync(p.path, { recursive: true, force: true });
  assert.equal(existsSync(p.path), false);
  assert.equal(backend.exists(ready), false, "a removed worktree is reported missing");

  const again = await backend.prepare(ready, repo);
  assert.equal(existsSync(again.path), true, "prepare re-attaches the worktree on its branch");
  assert.equal(backend.exists({ ...ready, status: { ...ready.status, path: again.path } } as unknown as Workspace), true);
});
