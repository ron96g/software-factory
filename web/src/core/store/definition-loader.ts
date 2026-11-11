import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { SYSTEM_NAMESPACE, type DocumentResource, type Resource } from "../model/resource.ts";
import type { DefinitionLoader } from "../ports/index.ts";

const MARKDOWN_DIRS = ["agents", "skills"];
const YAML_DIRS = ["workflows", "artifacts", "sources", "repositories", "model-providers", "sandbox-profiles"];

/** Loads definitions from a Git checkout into `factory-system` (ADR-0011: squads/<squad>/… comes in v0.4). */
export class GitDefinitionLoader implements DefinitionLoader {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async load(): Promise<Resource[]> {
    const out: Resource[] = [];
    for (const dir of MARKDOWN_DIRS) {
      for (const file of await this.files(dir, ".md")) {
        const text = await readFile(file, "utf8");
        out.push(this.finish(parseMarkdownResource(text, file), text));
      }
    }
    for (const dir of YAML_DIRS) {
      for (const file of await this.files(dir, ".yaml")) {
        const text = await readFile(file, "utf8");
        for (const doc of parseAllDocuments(text)) {
          const obj = doc.toJS() as Resource | null;
          if (obj) out.push(this.finish(obj, JSON.stringify(obj)));
        }
      }
    }
    return out;
  }

  private finish(obj: Resource, content: string): Resource {
    obj.metadata.namespace ??= SYSTEM_NAMESPACE;
    obj.metadata.uid ??= `def-${obj.kind}-${obj.metadata.name}`;
    obj.metadata.resourceVersion = createHash("sha256").update(content).digest("hex").slice(0, 12);
    return obj;
  }

  private async files(dir: string, ext: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, dir));
      return entries.filter((e) => e.endsWith(ext)).sort().map((e) => join(this.root, dir, e));
    } catch {
      return [];
    }
  }
}

export function parseMarkdownResource(text: string, origin = "<inline>"): DocumentResource {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${origin}: missing YAML frontmatter`);
  const obj = parseYaml(m[1]) as DocumentResource;
  obj.body = m[2].trim();
  return obj;
}
