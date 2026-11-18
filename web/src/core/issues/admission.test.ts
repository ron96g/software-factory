import assert from "node:assert/strict";
import { test } from "node:test";
import { issueContentHash, issueProposalValidator } from "./admission.ts";
import type { IssueProposal } from "../model/kinds.ts";

const src = (issues: boolean) => ({ kind: "Source", metadata: { name: "jira", namespace: "default" }, spec: { type: "jira", writeBack: issues ? { issues: { project: "X" } } : undefined } });
const item = (externalRef?: unknown) => ({ kind: "WorkItem", metadata: { name: "w", namespace: "default" }, spec: { externalRef } });
const reader = (objs: unknown[]) => ({
  get: async (kind: string, _ns: string, name: string) => (objs as { kind: string; metadata: { name: string } }[]).find((o) => o.kind === kind && o.metadata.name === name) ?? null,
  list: async () => [],
}) as never;
const prop = (spec: Partial<IssueProposal["spec"]>, name = "p", status?: IssueProposal["status"]): IssueProposal => ({
  apiVersion: "factory.ai-dlc.io/v1", kind: "IssueProposal", metadata: { name, namespace: "default" },
  spec: { purpose: "finding", title: "t", body: "b", ...spec }, status,
}) as IssueProposal;
const v = issueProposalValidator();
const run = (obj: IssueProposal, objs: unknown[], old?: IssueProposal) =>
  v.validate(obj, { operation: old ? "UPDATE" : "CREATE", oldObject: old, reader: reader(objs) });
const approve = { decision: "approve" as const };

test("approval needs a target Source with writeBack.issues", async () => {
  const human = { human: true };
  assert.match((await run(prop({ review: approve, provenance: human }), [src(true)], prop({})))[0], /target Source/);
  assert.match((await run(prop({ review: approve, provenance: human, targetRef: { name: "jira" } }), [src(false)], prop({})))[0], /target Source/);
  assert.deepEqual(await run(prop({ review: approve, provenance: human, targetRef: { name: "jira" } }), [src(true)], prop({})), []);
});

test("agents cannot create approved proposals", async () => {
  const p = prop({ review: approve, targetRef: { name: "jira" }, provenance: { agent: "a" } });
  assert.match((await run(p, [src(true)])).join(), /agents cannot create approved/);
  assert.deepEqual(await run(prop({ targetRef: { name: "jira" } }), [src(true)]), []);
});

test("publishing fields are frozen from Creating on", async () => {
  const old = prop({}, "p", { phase: "Creating" });
  assert.match((await run(prop({ title: "changed" }), [], old)).join(), /frozen/);
  assert.deepEqual(await run(prop({ resolution: { action: "link", externalId: "1" } }), [], old), []);
  assert.deepEqual(await run(prop({ title: "changed" }), [], prop({}, "p", { phase: "Proposed" })), []);
});

test("one mirror per item, only without externalRef", async () => {
  const mirror = (name: string) => prop({ purpose: "mirror", provenance: { workItem: "w" } }, name);
  assert.deepEqual(await run(mirror("w-mirror"), [item()]), []);
  assert.match((await run(mirror("other"), [item()])).join(), /w-mirror/);
  assert.match((await run(mirror("w-mirror"), [item({ externalId: "1" })])).join(), /already has an externalRef/);
});

test("content hash covers publishing fields only", () => {
  const a = prop({}).spec;
  assert.equal(issueContentHash(a), issueContentHash({ ...a, review: approve }));
  assert.notEqual(issueContentHash(a), issueContentHash({ ...a, labels: ["x"] }));
});
