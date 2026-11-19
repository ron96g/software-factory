import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryApp } from "../app/factory-app.ts";
import { issueContentHash } from "./admission.ts";

function app(proposal: any) {
  const writes: any[] = [];
  const self: any = {
    ns: "default",
    d: {
      reader: { get: async () => proposal, list: async () => [{ metadata: { name: "gh" }, spec: { type: "github", writeBack: { issues: {} } } }] },
      writer: { update: async (o: any) => { writes.push(o); return o; } },
      redactor: { redact: (s: string) => s },
    },
    listIssueTargets: async () => [{ source: "gh", type: "github" }],
    issueOrThrow: async () => proposal,
  };
  return { self, writes, proto: FactoryApp.prototype as any };
}
const p = () => ({ metadata: { name: "i" }, spec: { purpose: "finding", title: "t", body: "b", targetRef: { name: "gh" } }, status: { phase: "Proposed" } });

test("U7: approving binds the decision to the content hash; editing drops it", async () => {
  const a = app(p());
  const r = await a.proto.reviewIssueProposal.call(a.self, { id: "me" }, "i", "approve");
  assert.equal(r.spec.review.contentHash, issueContentHash(p().spec as any));
  const e = app({ ...p(), spec: { ...p().spec, review: r.spec.review } });
  const edited = await e.proto.updateIssueProposal.call(e.self, { id: "me" }, "i", { title: "new" });
  assert.equal(edited.spec.review, undefined);
  assert.equal(edited.spec.title, "new");
});

test("U7: only an uncertain or failed proposal can be resolved", async () => {
  const a = app(p());
  await assert.rejects(a.proto.resolveIssueProposal.call(a.self, { id: "me" }, "i", { action: "create-again" }), /uncertain or failed/);
  const f = app({ ...p(), status: { phase: "Failed" } });
  const r = await f.proto.resolveIssueProposal.call(f.self, { id: "me" }, "i", { action: "link", externalId: "7" });
  assert.equal(r.spec.resolution.externalId, "7");
});
