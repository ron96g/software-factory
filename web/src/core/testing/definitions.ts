import { resolve } from "node:path";
import type { Resource } from "../model/resource.ts";
import type { DefinitionLoader } from "../ports/index.ts";
import { GitDefinitionLoader } from "../store/definition-loader.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURES = resolve(import.meta.dirname, "fixtures");

/**
 * Repository definitions plus test-only fixture workflows (`test-loop`, `test-bolt`, `test-planned`, ADR-0074).
 * Engine tests use these fixtures so they don't depend on the production workflows.
 * `sourceWorkflows` repoints a Source's default workflow, e.g. `{ "github-issues": "test-loop" }`.
 */
export function testDefinitions(o: { root?: string; sourceWorkflows?: Record<string, string> } = {}): DefinitionLoader {
  const loaders = [new GitDefinitionLoader(o.root ?? REPO_ROOT), new GitDefinitionLoader(FIXTURES)];
  return {
    async load() {
      const all = (await Promise.all(loaders.map((l) => l.load()))).flat();
      return all.map((r) => {
        const workflow = r.kind === "Source" ? o.sourceWorkflows?.[r.metadata.name] : undefined;
        if (!workflow) return r;
        const spec = r.spec as { defaults?: Record<string, unknown> };
        return { ...r, spec: { ...spec, defaults: { ...spec.defaults, workflowRef: { name: workflow } } } } as Resource;
      });
    },
  };
}
