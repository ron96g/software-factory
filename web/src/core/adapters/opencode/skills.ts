/**
 * ADR-0060: OpenCode loads no project configuration, so the host offers the workspace's own skills itself. Only
 * skills inside the workspace are ever found: nothing from the host user or the factory's own harness.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface DiscoveredSkill {
  name: string;
  description?: string;
  /** Absolute path of the SKILL.md. */
  path: string;
  content: string;
}

const SKILL_DIRS = [".agents/skills", ".opencode/skills", ".claude/skills"];
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseSkill(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  try {
    const meta = parse(m[1]);
    return { meta: meta && typeof meta === "object" ? meta as Record<string, unknown> : {}, body: m[2] };
  } catch {
    return { meta: {}, body: m[2] };
  }
}

/** Repository roots in a session directory: the directory itself, or the checkouts of a multi-repository item. */
async function repositoryRoots(dir: string): Promise<string[]> {
  if (existsSync(join(dir, ".git"))) return [dir];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, ".git"))).map((e) => join(dir, e.name));
}

export async function discoverSkills(dir: string): Promise<DiscoveredSkill[]> {
  const found = new Map<string, DiscoveredSkill>();
  for (const root of await repositoryRoots(dir)) {
    for (const base of SKILL_DIRS) {
      const entries = await readdir(join(root, base), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(root, base, entry.name, "SKILL.md");
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text === undefined) continue;
        const { meta, body } = parseSkill(text);
        const name = typeof meta.name === "string" && NAME.test(meta.name) ? meta.name : entry.name;
        if (!NAME.test(name) || found.has(name)) continue;
        found.set(name, { name, description: typeof meta.description === "string" ? meta.description : undefined, path, content: body.trim() });
      }
    }
  }
  return [...found.values()];
}
