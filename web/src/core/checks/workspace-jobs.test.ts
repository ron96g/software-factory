import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun, WorkItem } from "../model/kinds.ts";
import type { ExecutionContext, ResourceReader } from "../ports/index.ts";
import { SerializedWorkspaceJobs } from "./workspace-jobs.ts";

test("workspace check submissions cannot overlap a candidate mutation, and pending checks exclude later mutations", async () => {
  const item = { metadata: { name: "item", namespace: "default", uid: "uid" } } as WorkItem;
  const checks: CheckRun[] = [];
  const reader = { get: async () => item, list: async () => checks } as unknown as ResourceReader;
  const jobs = new SerializedWorkspaceJobs(reader);
  const ctx = { workItem: item } as ExecutionContext;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const mutation = jobs.mutate(ctx, async () => { entered(); await held; });
  await started;
  let submitted = false;
  const submission = jobs.submit(item, async () => {
    submitted = true;
    checks.push({ spec: { workItemUid: "uid" } } as CheckRun);
  });
  await Promise.resolve();
  assert.equal(submitted, false);
  release();
  await Promise.all([mutation, submission]);
  assert.equal(submitted, true);
  await assert.rejects(jobs.mutate(ctx, async () => {}), /pending or running/);
  checks[0].status = { phase: "Completed" } as CheckRun["status"];
  await jobs.mutate(ctx, async () => {});
});
