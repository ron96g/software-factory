/**
 * Workspace path containment for the sandbox file tools (SEC-1, P0-1). The lexical check alone is not enough: a
 * committed symlink (`link -> ~/.ssh`) or a `..` reached through a symlinked directory escapes `node:fs`, which
 * follows symlinks. `LocalWorkspaceReaders` and `WorkspaceSnapshotter` already resolve with `realpath`; these are the
 * same rules, in the one place the sandbox adapters share.
 */
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** True when `p` is not inside `root`, or enters the workspace's `.git` directory. */
function escapes(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/)[0] === ".git";
}

/** Lexical containment: rejects `..`, absolute paths and `.git` before any filesystem access. */
export function resolveInWorkspace(root: string, p: string): string {
  const full = resolve(root, p);
  if (escapes(root, full)) throw new Error(`path escapes the workspace: ${p}`);
  return full;
}

/** Read: symlinks are followed, but the resolved target must stay inside the workspace. */
export async function resolveReadInWorkspace(root: string, p: string): Promise<string> {
  const full = resolveInWorkspace(root, p);
  const rootReal = await realpath(root);
  const real = await realpath(full);
  if (escapes(rootReal, real)) throw new Error(`path escapes the workspace (via symlink): ${p}`);
  return real;
}

/** Write: the nearest existing ancestor and the destination (if present) must resolve inside the workspace. */
export async function resolveWriteInWorkspace(root: string, p: string): Promise<string> {
  const full = resolveInWorkspace(root, p);
  const rootReal = await realpath(root);
  let ancestor = dirname(full);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (escapes(rootReal, await realpath(ancestor))) throw new Error(`path escapes the workspace (via symlink): ${p}`);
  const existing = await realpath(full).catch(() => undefined);
  if (existing && escapes(rootReal, existing)) throw new Error(`path escapes the workspace (via symlink): ${p}`);
  return full;
}

/** Create the parent directory and write, after `resolveWriteInWorkspace` has approved the path. */
export async function writeInsideWorkspace(full: string, content: string): Promise<void> {
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}
