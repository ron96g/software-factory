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

test("ADR-0068: click-created follow-ups need item, name, owner, revision and a matching hash", async () => {
  const w = { ...item(), metadata: { name: "w", namespace: "default" } };
  const owner = [{ apiVersion: "factory.ai-dlc.io/v1", kind: "WorkItem", name: "w", uid: "u" }];
  const mk = (spec: Partial<IssueProposal["spec"]>, name = "w-followup-r1", own: unknown = owner) => {
    const p = prop({ purpose: "follow-up", targetRef: { name: "jira" }, provenance: { human: true, workItem: "w" }, revision: "rev1", ...spec }, name);
    p.metadata.ownerReferences = own as never;
    return p;
  };
  const ok = mk({}); ok.spec.review = { decision: "approve", contentHash: issueContentHash(ok.spec) };
  assert.deepEqual(await run(ok, [src(true), w]), []);
  assert.match((await run(ok, [src(true)])).join(), /existing work item/);
  assert.match((await run(mk({ revision: undefined }), [src(true), w])).join(), /preview revision/);
  assert.match((await run(mk({}, "other"), [src(true), w])).join(), /named w-followup/);
  assert.match((await run(mk({}, "w-followup-r1", []), [src(true), w])).join(), /owned by/);
  const stale = mk({ review: { decision: "approve", contentHash: "x" } });
  assert.match((await run(stale, [src(true), w])).join(), /does not match/);
  const agent = mk({ provenance: { agent: "a", workItem: "w" }, review: { decision: "approve", contentHash: issueContentHash(ok.spec) } });
  assert.match((await run(agent, [src(true), w])).join(), /agents cannot create approved/);
  assert.notEqual(issueContentHash(ok.spec), issueContentHash({ ...ok.spec, revision: "rev2" }));
});

test("ADR-0077: a story ticket is bound to an approved gate decision and the exact draft that existed then", async () => {
  const owner = [{ apiVersion: "factory.ai-dlc.io/v1", kind: "WorkItem", name: "w", uid: "u" }];
  const approval = (decision?: "approve" | "reject", at = "2026-11-20T10:00:00Z") => ({ kind: "Approval", metadata: { name: "w-story-review-r3", namespace: "default", creationTimestamp: at }, spec: { workItemRef: { name: "w" }, stage: "story-review", decision, decidedBy: "alice" } });
  const draft = (at = "2026-11-20T09:00:00Z") => ({ kind: "Artifact", metadata: { name: "d1", namespace: "default", uid: "a1", resourceVersion: "7", creationTimestamp: at }, spec: { workItemRef: { name: "w" } } });
  const story = (name = "w-ticket", by = "alice", provenance: IssueProposal["spec"]["provenance"] = { human: true, proposedBy: by, workItem: "w", approval: "w-story-review-r3", artifact: { name: "d1", uid: "a1", resourceVersion: "7" } }) => {
    const p = prop({ purpose: "story", targetRef: { name: "jira" }, provenance }, name);
    p.metadata.ownerReferences = owner as never;
    p.spec.review = { decision: "approve", by, contentHash: issueContentHash(p.spec) };
    return p;
  };
  const w = { ...item(), metadata: { name: "w", namespace: "default" } };
  assert.deepEqual(await run(story(), [src(true), w, approval("approve"), draft()]), []);
  assert.match((await run(story("other"), [src(true), w, approval("approve"), draft()])).join(), /w-ticket/);
  assert.match((await run(story(), [src(true), w, approval("reject"), draft()])).join(), /approved gate decision/);
  assert.match((await run(story("w-ticket", "mallory"), [src(true), w, approval("approve"), draft()])).join(), /on behalf of the human who decided the gate/);
  const superseded = approval("approve");
  (superseded.metadata as Record<string, unknown>).labels = { "factory.ai-dlc.io/superseded": "true" };
  assert.match((await run(story(), [src(true), w, superseded, draft()])).join(), /current approved gate decision/);
  assert.match((await run(story(), [src(true), w, approval("approve"), { ...draft(), metadata: { ...draft().metadata, resourceVersion: "8" } }])).join(), /exact draft version/);
  assert.match((await run(story(), [src(true), w, approval("approve"), draft("2026-11-20T11:00:00Z")])).join(), /written after the approval/);
  const tampered = story();
  tampered.spec.body = "changed after the hash";
  assert.match((await run(tampered, [src(true), w, approval("approve"), draft()])).join(), /does not match the story ticket content/);
});
