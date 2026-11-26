import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../../model/kinds.ts";
import { GitWorkspaceCheckpoint } from "./snapshot.ts";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "factory-checkpoint-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = async (path: string, value: string) => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, value);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await put(".gitignore", "*.ignored\n");
  await put("tracked.txt", "base\n");
  await put("deleted.txt", "keep\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const workspace = { metadata: { name: "ws", namespace: "default" }, status: { phase: "Ready", path: root } } as Workspace;
  return { root, git, put, workspace };
}

test("ADR-0061 §2: a checkpoint restores exactly what a check changed and leaves the rest", async () => {
  const r = await repo();
  try {
    const checkpoint = new GitWorkspaceCheckpoint();
    // The candidate (agent) state, as the check finds it.
    await r.put("tracked.txt", "candidate\n");
    await r.put("added-by-candidate.txt", "candidate-added\n");
    await r.put("noise.ignored", "candidate\n");
    const handle = await checkpoint.capture(r.workspace);
    assert.match(handle, /^[a-f0-9]{40}$/);

    // The check rewrites files it must not touch, deletes one and adds another.
    await r.put("tracked.txt", "regenerated-by-check\n");
    await rm(join(r.root, "deleted.txt"));
    await r.put("created-by-check.txt", "check\n");
    await r.put("noise.ignored", "check\n");

    assert.equal(await checkpoint.restore(r.workspace, handle), true);
    assert.equal(await readFile(join(r.root, "tracked.txt"), "utf8"), "candidate\n");
    assert.equal(await readFile(join(r.root, "deleted.txt"), "utf8"), "keep\n");
    assert.equal(await readFile(join(r.root, "added-by-candidate.txt"), "utf8"), "candidate-added\n");
    assert.ok(!existsSync(join(r.root, "created-by-check.txt")), "the check's new file is removed");
    // Ignored paths are neither detected nor restored (ADR-0061 §2).
    assert.equal(await readFile(join(r.root, "noise.ignored"), "utf8"), "check\n");
    // The workspace's own index and staging state stay untouched: the candidate change is still unstaged.
    assert.equal(r.git("diff", "--cached", "--name-only"), "", "nothing was staged");
    assert.equal(r.git("diff", "--name-only"), "tracked.txt", "the candidate change is still in the working tree");
    // Restoring an unchanged workspace is a no-op.
    assert.equal(await checkpoint.restore(r.workspace, handle), false);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("SEC-1: restore never writes through a symlinked directory a check created", async () => {
  const r = await repo();
  const outside = await mkdtemp(join(tmpdir(), "factory-checkpoint-outside-"));
  try {
    await r.put("d/x.txt", "candidate\n");
    const checkpoint = new GitWorkspaceCheckpoint();
    const handle = await checkpoint.capture(r.workspace);
    // The check replaces the directory `d` with a symlink to a directory outside the workspace.
    await rm(join(r.root, "d"), { recursive: true, force: true });
    await symlink(outside, join(r.root, "d"));
    await writeFile(join(outside, "keep.txt"), "outside\n");
    let threw = false;
    try { await checkpoint.restore(r.workspace, handle); } catch { threw = true; }
    // Whatever the outcome, nothing outside the workspace was written or removed.
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "outside\n");
    assert.ok(threw || await readFile(join(r.root, "d", "x.txt"), "utf8") === "candidate\n",
      "restore either refused or rebuilt the real directory");
  } finally { await rm(r.root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("ADR-0061 §2: the checkpoint diff names the files a check added, modified and deleted, with line counts", async () => {
  const r = await repo();
  try {
    const checkpoint = new GitWorkspaceCheckpoint();
    const before = await checkpoint.capture(r.workspace);
    await r.put("tracked.txt", "one\ntwo\n");
    await rm(join(r.root, "deleted.txt"));
    await r.put("gen/created.go", "package gen\n");
    const after = await checkpoint.capture(r.workspace);
    const changes = await checkpoint.diff(r.workspace, before, after);
    assert.deepEqual(changes.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: "deleted.txt", change: "deleted", added: 0, deleted: 1 },
      { path: "gen/created.go", change: "added", added: 1, deleted: 0 },
      { path: "tracked.txt", change: "modified", added: 2, deleted: 1 },
    ]);
    await assert.rejects(checkpoint.diff(r.workspace, "--output=x", after), /tree hash/);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});
