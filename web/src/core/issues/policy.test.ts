import assert from "node:assert/strict";
import { test } from "node:test";
import { createIssuePolicy } from "./policy.ts";
import { canCreateIssues, canFindIssues } from "../ports/index.ts";
import { BUILTIN_KINDS } from "../registry/kinds.ts";
import type { Source } from "../model/kinds.ts";

const src = (writeBack?: Source["spec"]["writeBack"]): Source => ({ apiVersion: "factory.ai-dlc.io/v1", kind: "Source", metadata: { name: "s", namespace: "default" }, spec: { type: "jira", writeBack } }) as Source;

test("create-issue is denied without writeBack.issues and allowed with it", () => {
  assert.match(createIssuePolicy.check(src())!, /not permitted/);
  assert.match(createIssuePolicy.check(src({ transitions: true }))!, /not permitted/);
  assert.equal(createIssuePolicy.check(src({ issues: { project: "X" } })), undefined);
});

test("capability guards detect methods", () => {
  assert.equal(canCreateIssues({ type: "x" }), false);
  assert.equal(canFindIssues({ type: "x" }), false);
  assert.equal(canCreateIssues({ type: "x", createIssue: async () => ({ externalId: "1" }) } as never), true);
  assert.equal(canFindIssues({ type: "x", findCreatedIssues: async () => [] } as never), true);
});

test("IssueProposal kind is registered as runtime", () => {
  assert.equal(BUILTIN_KINDS.find((k) => k.kind === "IssueProposal")?.scope, "runtime");
});
