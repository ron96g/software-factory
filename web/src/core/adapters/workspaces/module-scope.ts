import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative } from "node:path";
import { promisify } from "node:util";
import type { ModuleCheckScope, ModuleScopeMode, Repository, Workspace } from "../../model/kinds.ts";
import { StoreError, type CandidateChanges, type CandidateDiffReader, type ModuleScopePlanner } from "../../ports/index.ts";
import { GIT_HARDENING, gitLocalEnv } from "./git-auth.ts";

const exec = promisify(execFile);
// The workspace is agent-writable: its git config must not run here (SEC-2, ADR-0092 §6).
const safePath = (path: string) => /^[a-zA-Z0-9_.][a-zA-Z0-9_./-]*$/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
type Module = { path: string; depends_on: string[] };

function moduleGraph(text: string): Record<string, Module> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    throw new StoreError("module graph must be a non-empty object", "Invalid");
  }
  const graph: Record<string, Module> = {};
  const paths = new Set<string>();
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !("path" in entry) || typeof entry.path !== "string" || !safePath(entry.path) ||
        !("depends_on" in entry) || !Array.isArray(entry.depends_on) ||
        !entry.depends_on.every((dep: unknown) => typeof dep === "string")) {
      throw new StoreError(`invalid module graph entry: ${name}`, "Invalid");
    }
    if (paths.has(entry.path)) throw new StoreError(`duplicate module path: ${entry.path}`, "Invalid");
    paths.add(entry.path);
    Object.defineProperty(graph, name, { value: { path: entry.path, depends_on: entry.depends_on }, enumerable: true });
  }
  for (const [name, module] of Object.entries(graph)) {
    if (module.depends_on.some((dependency) => !Object.hasOwn(graph, dependency))) {
      throw new StoreError(`module ${name} references an unknown dependency`, "Invalid");
    }
  }
  return graph;
}

/**
 * ADR-0089: read the module graph from the pinned base commit, not the working tree, so a candidate cannot narrow its
 * own verification scope by editing the graph. `graphRelative` is the declared, normalised path (used for the base
 * lookup, so a symlinked working-tree graph cannot redirect it); `graphPath` is the working-tree path, read only when
 * the graph is new in this candidate (absent at the base). The declared path is resolved first, so a graph that escapes
 * the workspace is rejected.
 */
async function graphTextAt(cwd: string, baseCommit: string, graphRelative: string, graphPath: string): Promise<string> {
  const git = async (args: string[]) => (await exec("git", [...GIT_HARDENING, ...args], { cwd, env: gitLocalEnv(), maxBuffer: 16 * 1024 * 1024 })).stdout;
  try {
    await git(["cat-file", "-e", `${baseCommit}:${graphRelative}`]);
  } catch {
    // The path is absent at the base (a graph that is new in this candidate); the base commit itself was validated first.
    return readFile(graphPath, "utf8");
  }
  return git(["show", `${baseCommit}:${graphRelative}`]);
}

/** Committed, staged, unstaged and untracked changes since `baseCommit`, workspace-relative and sorted. */
async function changedSince(cwd: string, baseCommit: string): Promise<string[]> {
  const git = async (args: string[]) => (await exec("git", [...GIT_HARDENING, ...args], { cwd, env: gitLocalEnv(), maxBuffer: 16 * 1024 * 1024 })).stdout;
  await git(["cat-file", "-e", `${baseCommit}^{commit}`]);
  // Disabling rename detection includes both the old and new owners, including staged renames.
  return [...new Set((
    await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, "--"]) +
    await git(["ls-files", "--others", "--exclude-standard", "-z"])
  ).split("\0").filter(Boolean))].sort();
}

/** ADR-0086: the same changed-file view the module scope uses. */
export class GitCandidateChanges implements CandidateChanges {
  async changedFiles(workspace: Workspace): Promise<string[]> {
    const cwd = workspace.status?.path;
    const baseCommit = workspace.status?.baseCommit;
    if (!cwd || !baseCommit || !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new StoreError("changed files require a workspace path and pinned baseCommit", "Invalid");
    return changedSince(cwd, baseCommit);
  }
}

/** ADR-0094: the committed diff against the pinned base; diff drivers and textconv stay disabled (SEC-2). */
export class GitCandidateDiff implements CandidateDiffReader {
  async diff(workspace: Workspace, maxBytes: number) {
    const cwd = workspace.status?.path;
    const baseCommit = workspace.status?.baseCommit;
    if (!cwd || !baseCommit || !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new StoreError("a diff requires a workspace path and pinned baseCommit", "Invalid");
    const git = async (args: string[]) => (await exec("git", [...GIT_HARDENING, ...args], { cwd, env: gitLocalEnv(), maxBuffer: 64 * 1024 * 1024 })).stdout;
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseCommit, "HEAD", "--"];
    const stat = await git([...args.slice(0, 4), "--stat=200", ...args.slice(4)]);
    const full = await git(args);
    const truncated = Buffer.byteLength(full) > maxBytes;
    return { stat, patch: truncated ? Buffer.from(full).subarray(0, maxBytes).toString("utf8") : full, truncated };
  }
}

/** Reuse the repository's CI graph; Git reads include the full candidate, not just its last commit. */
export class GitModuleScopePlanner implements ModuleScopePlanner {
  async plan(workspace: Workspace, repository: Repository, selection: ModuleScopeMode = "affected"): Promise<ModuleCheckScope> {
    const policy = repository.spec.moduleScope;
    const cwd = workspace.status?.path;
    const baseCommit = workspace.status?.baseCommit;
    if (!policy || !safePath(policy.graph) || !Array.isArray(policy.sharedPaths) ||
        !policy.sharedPaths.every((path) => typeof path === "string" && !!path.trim()) ||
        policy.nonBuildPaths !== undefined && (!Array.isArray(policy.nonBuildPaths) ||
          !policy.nonBuildPaths.every((path) => typeof path === "string" && !!path.trim()))) {
      throw new StoreError("module-scoped checks require a graph and sharedPaths policy", "Invalid");
    }
    if (!cwd || !baseCommit || !/^[a-f0-9]{40,64}$/.test(baseCommit)) {
      throw new StoreError("module scope requires a workspace path and pinned baseCommit", "Invalid");
    }
    const root = await realpath(cwd);
    // The base lookup uses the declared, normalised path, so a candidate cannot redirect it by symlinking the graph
    // file. The working-tree path is resolved only to reject a graph that escapes the workspace (and for the fallback).
    const graphPath = join(root, policy.graph);
    const resolved = await realpath(graphPath).catch(() => undefined);
    if (resolved) {
      const inside = relative(root, resolved);
      if (inside.startsWith("..") || isAbsolute(inside)) throw new StoreError("module graph escapes the workspace", "Invalid");
    }
    // `changedSince` validates the base commit, so `graphTextAt` only falls back when the graph path is absent at the base.
    const changed = await changedSince(cwd, baseCommit);
    const graphText = await graphTextAt(cwd, baseCommit, policy.graph, graphPath);
    const graph = moduleGraph(graphText);
    const scope = {
      baseCommit, graphHash: createHash("sha256").update(graphText).digest("hex"),
      modules: Object.values(graph).map((module) => module.path).sort(),
    };
    const full = (reason: string): ModuleCheckScope => ({ ...scope, mode: "full", reason });
    if (selection === "full") return full("Verification policy requires full scope for this check.");
    if (!changed.length) return full("No candidate changes; validate the full baseline.");
    // ADR-0089: a changed dependency manifest is module-local, and the repository declares its derived graph under
    // nonBuildPaths, so the graph is metadata. Genuinely shared tooling and configuration still require full validation.
    if (changed.some((path) => policy.sharedPaths.some((pattern) => matchesGlob(path, pattern)))) {
      return full("Shared tooling or configuration changes require full validation.");
    }
    const buildChanges = changed.filter((path) => !policy.nonBuildPaths?.some((pattern) => matchesGlob(path, pattern)));
    if (!buildChanges.length) return full("Only non-build paths changed; validate the full baseline.");
    const selected = new Set<string>();
    const owners = Object.entries(graph).sort((a, b) => b[1].path.length - a[1].path.length);
    for (const path of buildChanges) {
      const owner = owners.find(([, module]) => path === module.path || path.startsWith(`${module.path}/`));
      if (!owner) return full("Changes outside known modules require full validation.");
      selected.add(owner[0]);
    }
    if (selection === "changed") {
      return { ...scope, mode: "changed", modules: [...selected].map((name) => graph[name].path).sort(), reason: "Changed modules only (readiness tier)." };
    }
    let size;
    do {
      size = selected.size;
      for (const [name, module] of Object.entries(graph)) {
        if (module.depends_on.some((dependency) => selected.has(dependency))) selected.add(name);
      }
    } while (size !== selected.size);
    return {
      ...scope, mode: "affected", modules: [...selected].map((name) => graph[name].path).sort(),
      reason: "Changed modules and their transitive dependents.",
    };
  }
}
