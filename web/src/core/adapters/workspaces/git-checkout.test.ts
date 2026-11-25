import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Repository, Workspace } from "../../model/kinds.ts";
import { GitWorktreeWorkspaces } from "./git-worktree.ts";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** An origin the factory can clone from, plus the (absent) path its definitions declare. */
function origin(): { url: string; declared: string } {
  const work = mkdtempSync(join(tmpdir(), "sf-origin-work-"));
  gitIn(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\n");
  gitIn(work, "add", ".");
  gitIn(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const bare = join(mkdtempSync(join(tmpdir(), "sf-origin-bare-")), "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { stdio: "pipe" });
  // The declared checkout does not exist yet, exactly like a fresh machine.
  return { url: `file://${bare}`, declared: join(mkdtempSync(join(tmpdir(), "sf-checkout-")), "nested", "repo") };
}

const backendFor = (root: string) => new GitWorktreeWorkspaces({ definitionsRoot: root, workspacesDir: mkdtempSync(join(tmpdir(), "sf-ws-")), secrets: { resolve: () => undefined } });

const repoOf = (url: string, path: string): Repository =>
  ({ metadata: { name: "controlplane", namespace: "factory-system" }, spec: { local: { path }, git: { url, defaultBranch: "main" } } }) as unknown as Repository;

const wsOf = (name = "item"): Workspace =>
  ({ apiVersion: "v", kind: "Workspace", metadata: { name: `${name}-controlplane`, namespace: "default" }, spec: { workItemRef: { name }, repositoryRef: { name: "controlplane" }, branch: `factory/${name}` } }) as unknown as Workspace;

/** ADR-0021 addendum: a missing operator checkout is provisioned by the factory, not a stuck item. */
test("prepare clones the declared checkout when the path is absent, and reuses it afterwards", async () => {
  const { url, declared } = origin();
  const backend = backendFor(process.cwd());
  const repo = repoOf(url, declared);
  const ws = wsOf();

  const first = await backend.prepare(ws, repo);
  assert.ok(existsSync(join(declared, ".git")), "the factory cloned into the declared path");
  assert.ok(existsSync(join(first.path, "a.txt")), "the worktree has the cloned content");
  assert.match(first.headCommit, /^[0-9a-f]{40}$/);

  // Uncommitted files in the checkout must survive the second prepare: it reuses, never re-clones.
  writeFileSync(join(declared, "keep.txt"), "keep\n");
  const second = await backend.prepare(ws, repo);
  assert.ok(existsSync(join(declared, "keep.txt")), "an existing checkout is reused, not cloned over");
  assert.equal(second.baseCommit, first.baseCommit, "the base commit stays pinned");
});

/** ADR-0021 addendum: an existing checkout is used as-is (no network, no clone). */
test("prepare uses an existing checkout without cloning", async () => {
  const work = mkdtempSync(join(tmpdir(), "sf-existing-"));
  gitIn(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\n");
  gitIn(work, "add", ".");
  gitIn(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  // A URL that cannot be cloned: reaching it would fail the test.
  const repo = repoOf("file:///nonexistent/does-not-exist.git", work);

  const prepared = await backendFor(process.cwd()).prepare(wsOf(), repo);
  assert.ok(existsSync(join(prepared.path, "a.txt")));
});

/** ADR-0021 addendum: never destroy a directory that is not a checkout. */
test("prepare refuses to clone over an existing non-git directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-not-a-repo-"));
  writeFileSync(join(dir, "important.txt"), "do not lose me\n");
  const repo = repoOf("file:///nonexistent/does-not-exist.git", dir);

  await assert.rejects(backendFor(process.cwd()).prepare(wsOf(), repo), /exists but is not a usable git checkout/);
  assert.ok(existsSync(join(dir, "important.txt")), "the directory is left untouched");
});

/** A leftover partial clone has a `.git` but no HEAD: refused with the path, never used as a source. */
test("prepare refuses a checkout without a commit at HEAD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-empty-repo-"));
  gitIn(dir, "init", "-q", "-b", "main");
  const repo = repoOf("file:///nonexistent/does-not-exist.git", dir);

  await assert.rejects(backendFor(process.cwd()).prepare(wsOf(), repo), /exists but is not a usable git checkout/);
});

/** An empty directory is a normal way to pre-create the declared path; clone into it. */
test("prepare clones into a pre-created empty directory", async () => {
  const { url } = origin();
  const empty = join(mkdtempSync(join(tmpdir(), "sf-precreated-")), "repo");
  execFileSync("mkdir", ["-p", empty]);
  const repo = repoOf(url, empty);

  const prepared = await backendFor(process.cwd()).prepare(wsOf(), repo);
  assert.ok(existsSync(join(empty, ".git")), "the empty directory received the clone");
  assert.ok(existsSync(join(prepared.path, "a.txt")));
});

/** SEC-3: whatever the secret resolver returns, the clone carries no credential in its configuration. */
test("the clone's configuration holds no credential", async () => {
  const { url, declared } = origin();
  const backend = new GitWorktreeWorkspaces({ definitionsRoot: process.cwd(), workspacesDir: mkdtempSync(join(tmpdir(), "sf-ws-")), secrets: { resolve: () => "s3cr3t-token" } });
  const repo = repoOf(url, declared);

  await backend.prepare(wsOf(), repo);
  const config = execFileSync("git", ["config", "--list", "--local"], { cwd: declared, stdio: "pipe" }).toString();
  assert.ok(!config.includes("s3cr3t-token"), "the token is not written to the checkout");
  assert.equal(execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: declared, stdio: "pipe" }).toString().trim(), url);
});

/** A failed clone names the repository, the URL and the path (not a bare `ENOENT`). */
test("a failed clone reports the repository, URL and path", async () => {
  const declared = join(mkdtempSync(join(tmpdir(), "sf-fail-")), "repo");
  const repo = repoOf("file:///nonexistent/does-not-exist.git", declared);

  await assert.rejects(backendFor(process.cwd()).prepare(wsOf(), repo), (error: Error) => {
    assert.match(error.message, /repository controlplane: cloning file:\/\/\/nonexistent\/does-not-exist\.git into /);
    assert.match(error.message, new RegExp(declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
});

/** Removing a workspace must never provision a checkout. */
test("remove never clones a missing checkout", async () => {
  const { url, declared } = origin();
  const backend = backendFor(process.cwd());
  const repo = repoOf(url, declared);
  const ws = wsOf("cleanup");
  const prepared = await backend.prepare(ws, repo);
  rmSync(declared, { recursive: true, force: true });

  await backend.remove({ ...ws, status: { phase: "Ready", path: prepared.path, baseCommit: prepared.baseCommit, headCommit: prepared.headCommit, preparedBy: "host-git-worktree", setupCompleted: true } } as unknown as Workspace, repo);
  assert.ok(!existsSync(declared), "removal did not clone the checkout back");
  assert.ok(!existsSync(prepared.path), "the worktree is gone");
});

/** A repository without a URL cannot be provisioned; the failure says so instead of a bare `ENOENT`. */
test("prepare reports a missing git URL when the checkout is absent", async () => {
  const declared = join(mkdtempSync(join(tmpdir(), "sf-no-url-")), "repo");
  const repo = { metadata: { name: "controlplane", namespace: "factory-system" }, spec: { local: { path: declared } } } as unknown as Repository;

  await assert.rejects(backendFor(process.cwd()).prepare(wsOf(), repo), /has no spec\.git\.url/);
});
