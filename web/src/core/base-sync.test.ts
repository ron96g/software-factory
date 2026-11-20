import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repository, Workspace } from "./model/kinds.ts";
import { API_VERSION } from "./model/resource.ts";
import { GitBaseSync } from "./adapters/workspaces/git-base-sync.ts";
import { GitBranchPublisher } from "./adapters/workspaces/git-publish.ts";

const secrets = { resolve: () => undefined };

/** A bare `origin` with `main`, plus a workspace clone on `factory/item` forked from it. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-base-sync-"));
  const origin = join(root, "origin.git");
  const other = join(root, "other");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const init = (dir: string) => {
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "Test");
  };
  git(root, "init", "-q", "--bare", origin);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", "-q", origin, other);
  init(other);
  git(other, "checkout", "-q", "-b", "main");
  await writeFile(join(other, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(other, "b.txt"), "b\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "init");
  git(other, "push", "-q", "origin", "main");
  // Like production (ADR-0021): the workspace is a worktree of a local checkout.
  const source = join(root, "source");
  git(root, "clone", "-q", "-b", "main", origin, source);
  init(source);
  git(source, "worktree", "add", "-q", "-b", "factory/item", work, "main");
  const fork = git(work, "rev-parse", "HEAD");
  const repo = { apiVersion: API_VERSION, kind: "Repository", metadata: { name: "r", namespace: "default" },
    spec: { git: { url: `file://${origin}`, defaultBranch: "main" } } } as unknown as Repository;
  const ws = (baseCommit = fork) => ({ apiVersion: API_VERSION, kind: "Workspace", metadata: { name: "item-r", namespace: "default" },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "r" }, branch: "factory/item" },
    status: { phase: "Ready", path: work, baseCommit } }) as unknown as Workspace;
  const mergeHead = () => existsSync(join(git(work, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
  const landOnMain = async (file: string, content: string) => {
    git(other, "pull", "-q", "origin", "main");
    await writeFile(join(other, file), content);
    git(other, "commit", "-q", "-am", `change ${file}`);
    git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  };
  return { root, origin, work, git, mergeHead, repo, ws, landOnMain, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test("ADR-0053: a parallel change on main that touches other files is not a conflict", async () => {
  const f = await fixture();
  try {
    await f.landOnMain("b.txt", "b changed on main\n");
    await writeFile(join(f.work, "a.txt"), "one\nTWO (item)\nthree\n");
    const r = await new GitBaseSync(secrets).detect(f.ws(), f.repo, "main");
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.baseCommit, f.git(f.origin, "rev-parse", "main"));
  } finally {
    await f.cleanup();
  }
});

test("ADR-0053: conflict is detected without touching the workspace, merged with markers, then published as a merge", async () => {
  const f = await fixture();
  try {
    const sync = new GitBaseSync(secrets);
    const mainCommit = await f.landOnMain("a.txt", "one\nTWO (main)\nthree\n");
    await writeFile(join(f.work, "a.txt"), "one\nTWO (item)\nthree\n");
    await writeFile(join(f.work, "new.txt"), "untracked work\n");
    const statusBefore = f.git(f.work, "status", "--porcelain");

    const detected = await sync.detect(f.ws(), f.repo, "main");
    assert.deepEqual(detected.conflicts, ["a.txt"]);
    assert.equal(detected.baseCommit, mainCommit);
    assert.equal(f.git(f.work, "status", "--porcelain"), statusBefore, "detection leaves the workspace untouched");
    assert.equal(f.git(f.work, "worktree", "list").split("\n").length, 2, "only source + workspace: the trial worktree is removed");

    const merged = await sync.integrate(f.ws(), f.repo, detected.baseCommit);
    assert.deepEqual(merged.conflicts, ["a.txt"]);
    assert.equal(merged.baseCommit, mainCommit);
    assert.match(await readFile(join(f.work, "a.txt"), "utf8"), /<<<<<<< /);
    assert.ok(f.mergeHead());
    assert.equal(f.git(f.work, "diff", "--name-only", "--diff-filter=U"), "", "the index carries no unmerged entries");
    assert.deepEqual((await sync.integrate(f.ws(), f.repo, detected.baseCommit)).conflicts, ["a.txt"], "re-entry is idempotent");

    const repinned = f.ws(merged.baseCommit);
    assert.deepEqual((await sync.detect(repinned, f.repo, "main")).conflicts, ["a.txt"], "leftover markers still block publication");

    await writeFile(join(f.work, "a.txt"), "one\nTWO (item and main)\nthree\n");
    assert.deepEqual((await sync.detect(repinned, f.repo, "main")).conflicts, []);

    const pushed = await new GitBranchPublisher(secrets).publish(repinned, f.repo, "Item title");
    assert.equal(f.git(f.origin, "rev-parse", "factory/item"), pushed.commit);
    assert.equal(f.git(f.origin, "rev-list", "--parents", "-n", "1", pushed.commit).split(" ").length, 3, "a merge commit");
    f.git(f.origin, "merge-base", "--is-ancestor", "main", "factory/item");
    assert.ok(!f.mergeHead());
  } finally {
    await f.cleanup();
  }
});

test("ADR-0053: when the base moves again, a resolved earlier merge is finished first; unresolved markers are never committed", async () => {
  const f = await fixture();
  try {
    const sync = new GitBaseSync(secrets);
    await f.landOnMain("a.txt", "one\nTWO (main)\nthree\n");
    await writeFile(join(f.work, "a.txt"), "one\nTWO (item)\nthree\n");
    const first = await sync.integrate(f.ws(), f.repo, (await sync.detect(f.ws(), f.repo, "main")).baseCommit);
    const afterFirst = f.ws(first.baseCommit);

    await f.landOnMain("a.txt", "one\nTWO (main again)\nthree\n");
    const second = await sync.detect(afterFirst, f.repo, "main");
    await assert.rejects(sync.integrate(afterFirst, f.repo, second.baseCommit), /still has conflict markers/);

    await writeFile(join(f.work, "a.txt"), "one\nTWO (item and main)\nthree\n");
    const merged = await sync.integrate(afterFirst, f.repo, second.baseCommit);
    assert.deepEqual(merged.conflicts, ["a.txt"]);
    assert.equal(f.git(f.work, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "the first merge was committed");
    assert.match(await readFile(join(f.work, "a.txt"), "utf8"), /<<<<<<< [\s\S]*main again/);
  } finally {
    await f.cleanup();
  }
});
