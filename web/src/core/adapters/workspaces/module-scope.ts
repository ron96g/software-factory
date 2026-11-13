import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative } from "node:path";
import { promisify } from "node:util";
import type { ModuleCheckScope, Repository, Workspace } from "../../model/kinds.ts";
import { StoreError, type ModuleScopePlanner } from "../../ports/index.ts";

const exec = promisify(execFile);
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

/** Reuse the repository's CI graph; Git reads include the full candidate, not just its last commit. */
export class GitModuleScopePlanner implements ModuleScopePlanner {
  async plan(workspace: Workspace, repository: Repository): Promise<ModuleCheckScope> {
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
    const graphPath = await realpath(join(root, policy.graph));
    const graphRelative = relative(root, graphPath);
    if (graphRelative.startsWith("..") || isAbsolute(graphRelative)) throw new StoreError("module graph escapes the workspace", "Invalid");
    const graphText = await readFile(graphPath, "utf8");
    const graph = moduleGraph(graphText);
    const git = async (args: string[]) => (await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
    await git(["cat-file", "-e", `${baseCommit}^{commit}`]);
    // Disabling rename detection includes both the old and new owners, including staged renames.
    const changed = [...new Set((
      await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, "--"]) +
      await git(["ls-files", "--others", "--exclude-standard", "-z"])
    ).split("\0").filter(Boolean))].sort();
    const scope = {
      baseCommit, graphHash: createHash("sha256").update(graphText).digest("hex"),
      modules: Object.values(graph).map((module) => module.path).sort(),
    };
    const full = (reason: string): ModuleCheckScope => ({ ...scope, mode: "full", reason });
    if (!changed.length) return full("No candidate changes; validate the full baseline.");
    if (changed.some((path) => path === policy.graph || policy.sharedPaths.some((pattern) => matchesGlob(path, pattern)))) {
      return full("Shared tooling, dependency or graph changes require full validation.");
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
