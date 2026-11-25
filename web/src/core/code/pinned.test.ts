import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Workspace } from "../model/kinds.ts";
import { pinnedWorkspaceFiles } from "./pinned.ts";

const item = { apiVersion: "v", kind: "WorkItem", metadata: { name: "item", namespace: "default", uid: "u1" } };
const provenance = { workspaces: { repo: "abc123" } };

const workspaceIn = (path: string): Workspace =>
  ({ apiVersion: "v", kind: "Workspace",
    metadata: { name: "item-repo", namespace: "default", ownerReferences: [{ kind: "WorkItem", name: "item", uid: "u1" }] },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "factory/item" },
    status: { phase: "Ready", path, baseCommit: "abc123" } }) as unknown as Workspace;

/** ADR-0057: a stale `Ready` (its files were swept by another instance) must not read as "the agent cited a file it never read". */
test("a Ready workspace whose files are gone is not a readable pinned workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-pinned-"));
  const reader = { list: async () => [workspaceIn(dir)] };
  const readers = { forWorkspaces: () => ({ readFile: async () => "content" }) };

  const present = await pinnedWorkspaceFiles(reader as never, readers as never, item as never, provenance as never);
  assert.ok(present.files, "a Ready workspace with its files on disk is readable");

  rmSync(dir, { recursive: true, force: true });
  const gone = await pinnedWorkspaceFiles(reader as never, readers as never, item as never, provenance as never);
  assert.equal(gone.files, null, "a stale Ready status with no files must not be offered as readable");
  assert.deepEqual(gone.repositories, ["repo"], "the run's repositories are still reported, so the caller can explain");
});
