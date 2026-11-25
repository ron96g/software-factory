import { existsSync } from "node:fs";
import { nsOf } from "../model/meta.ts";
import type { RunProvenance, Workspace, WorkItem } from "../model/kinds.ts";
import type { FileReader, ResourceReader, WorkspaceReaderFactory } from "../ports/index.ts";

/**
 * ADR-0057: read-only access to the workspaces a run saw, only if each is still Ready **and its files are still there**
 * at the commit recorded in its provenance. Returns null otherwise: code locations can then no longer be checked.
 *
 * The directory check matters: a workspace whose files were removed (a sweep by another instance, a manual cleanup)
 * keeps a stale `Ready` status until its controller notices, and a read against it fails with `ENOENT` — which reads as
 * "the agent cited a file it never read" instead of "the code the review saw is gone".
 */
export async function pinnedWorkspaceFiles(
  reader: ResourceReader, readers: WorkspaceReaderFactory, item: WorkItem, provenance: RunProvenance | undefined,
): Promise<{ repositories: string[]; files: FileReader | null }> {
  const pinned = Object.fromEntries(Object.entries(provenance?.workspaces ?? {}).filter(([, commit]) => !!commit));
  const repositories = Object.keys(pinned);
  if (!repositories.length) return { repositories, files: null };
  const owned = (await reader.list<Workspace>("Workspace", { namespace: nsOf(item),
    ownedBy: { kind: "WorkItem", name: item.metadata.name, namespace: nsOf(item) } }))
    .filter((w) => w.status?.phase === "Ready" && w.status.path && existsSync(w.status.path));
  const matching = repositories.map((repo) => owned.find((w) => w.spec.repositoryRef.name === repo && w.status?.baseCommit === pinned[repo]));
  return { repositories, files: matching.every((w): w is Workspace => !!w) ? readers.forWorkspaces(matching) : null };
}
