import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBundleIngest } from "./git-export.ts";
import { ExportRejectedError } from "../../ports/index.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env }).toString().trim();

/** A source repository with one commit, and a self-contained bundle of it. */
function source(dir: string) {
  const repo = join(dir, "src");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const commit = git(repo, "rev-parse", "HEAD");
  const bundle = join(dir, "candidate.bundle");
  git(repo, "bundle", "create", bundle, "--all");
  return { repo, commit, bundle };
}

test("S1 (ADR-0080 §13): a self-contained bundle is ingested into a factory-owned bare mirror, never checked out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-export-"));
  try {
    const { commit, bundle } = source(dir);
    const mirror = join(dir, "mirror");
    const result = await new GitBundleIngest().ingest({ bundlePath: bundle, mirrorPath: mirror });

    assert.equal(result.commit, commit);
    assert.equal(git(mirror, "rev-parse", "--is-bare-repository"), "true");
    assert.ok(existsSync(join(mirror, "HEAD")), "bare mirror has a HEAD");
    assert.ok(!existsSync(join(mirror, ".git")), "no working tree");
    // The commit is readable through plumbing only.
    assert.equal(git(mirror, "cat-file", "-p", `${commit}:a.txt`), "hello");
    assert.ok(result.objects >= 2 && result.refs >= 1 && result.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1: a symlink is recorded as a blob, never followed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-export-symlink-"));
  try {
    const repo = join(dir, "src");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "target.txt"), "secret contents\n");
    symlinkSync("target.txt", join(repo, "link"));
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const bundle = join(dir, "candidate.bundle");
    git(repo, "bundle", "create", bundle, "--all");

    const mirror = join(dir, "mirror");
    const result = await new GitBundleIngest().ingest({ bundlePath: bundle, mirrorPath: mirror });
    assert.match(git(mirror, "ls-tree", "-r", result.commit), /120000 blob \S+\tlink/, "the symlink is a blob, not a followed target");
    assert.equal(git(mirror, "cat-file", "-p", `${result.commit}:link`), "target.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1: a commit carrying a submodule (gitlink) is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-export-submodule-"));
  try {
    const repo = join(dir, "src");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "x\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`);
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add gitlink");
    const bundle = join(dir, "candidate.bundle");
    git(repo, "bundle", "create", bundle, "--all");

    await assert.rejects(
      new GitBundleIngest().ingest({ bundlePath: join(dir, "candidate.bundle"), mirrorPath: join(dir, "mirror") }),
      (e: unknown) => e instanceof ExportRejectedError && e.reason === "submodules",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1: size and object limits reject the export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-export-limits-"));
  try {
    const { bundle } = source(dir);
    await assert.rejects(
      new GitBundleIngest().ingest({ bundlePath: bundle, mirrorPath: join(dir, "m1"), limits: { maxBytes: 10 } }),
      (e: unknown) => e instanceof ExportRejectedError && e.reason === "too-large",
    );
    await assert.rejects(
      new GitBundleIngest().ingest({ bundlePath: bundle, mirrorPath: join(dir, "m2"), limits: { maxObjects: 1 } }),
      (e: unknown) => e instanceof ExportRejectedError && e.reason === "too-many-objects",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1: a file that is not a git bundle is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-export-bad-"));
  try {
    const notBundle = join(dir, "not-a-bundle");
    writeFileSync(notBundle, "this is not a bundle\n");
    await assert.rejects(
      new GitBundleIngest().ingest({ bundlePath: notBundle, mirrorPath: join(dir, "mirror") }),
      (e: unknown) => e instanceof ExportRejectedError && e.reason === "bad-bundle",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
