import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun, WorkItem } from "../model/kinds.ts";
import type { ExecutionContext, ResourceReader } from "../ports/index.ts";
import { ActiveCheckFinishValidator } from "./finish-guard.ts";

test("finish waits for caller-owned active checks but not another run's checks", async () => {
  const item = { metadata: { name: "item", namespace: "default", uid: "item-uid" } } as WorkItem;
  const ctx = { workItem: item, run: { metadata: { name: "run", uid: "run-uid" } } } as ExecutionContext;
  const check = { spec: { workItemUid: "item-uid", workflow: { agentRunRef: { name: "run" }, agentRunUid: "run-uid" } },
    metadata: { name: "job" } } as CheckRun;
  const reader = { get: async () => item, list: async () => [check] } as unknown as ResourceReader;
  const guard = new ActiveCheckFinishValidator(reader);
  assert.match((await guard.validate(ctx))[0], /still running/);
  check.status = { phase: "Completed" } as CheckRun["status"];
  assert.deepEqual(await guard.validate(ctx), []);
  check.status = undefined;
  check.spec.workflow!.agentRunUid = "other";
  assert.deepEqual(await guard.validate(ctx), []);
});
